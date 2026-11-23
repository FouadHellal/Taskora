/**
 * Client portal API (/api/portal/*). Contacts with portal access sign in with
 * their own credentials (separate cookie and session table). A contact sees
 * their own tickets; a portal *manager* (role `manager`, or the company's
 * primary contact) sees every ticket of the company, its work summary and its
 * contracts. Clients can open requests, reply, attach files and write their
 * company documentation — they never see internal notes, internal time notes,
 * rates or other staff data and cannot change a ticket's status, resolution or
 * time. What is shown is set in Administration → Client portal.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { formatNumber, noteImageIds } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { idOf } from '../../lib/params.js';
import { likeTerm, nextSequence } from '../../lib/query.js';
import { getSystemSettings, type SystemSettings } from '../../lib/settings.js';
import { addTicketNote, createTicket, updateTicket } from '../tickets/service.js';
import { runTicketRules } from '../automation/engine.js';
import { enqueue } from '../../jobs/queue.js';
import { sendBranded } from '../../jobs/client-email.js';
import { mailLang, mailTranslator } from '../../jobs/mail-i18n.js';
import { registerPortalEngagement } from './engagement.js';
import { resolveSmtp, transportFor } from '../../lib/mail.js';
import { INLINE_IMAGE_TYPES, portalImageUrls } from '../../lib/note-images.js';
import { COUNTED_STATUSES, contractBalances } from '../contracts/coverage.js';
import type { Db } from '../../db/client.js';

export const PORTAL_COOKIE = 'taskora_portal';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export const PORTAL_ROLES = ['user', 'manager'] as const;

export interface PortalContact {
  id: number;
  companyId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  /** Sees the whole company (tickets, work, contracts): role manager or primary contact. */
  isManager: boolean;
  csrfToken: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    portalContact: PortalContact | null;
  }
}

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(256) });
const optId = z.coerce.number().int().positive().nullish();
const ticketSchema = z.object({
  title: z.string().trim().min(3, 'Please describe the issue briefly').max(255),
  description: z.string().trim().max(20000).default(''),
  priorityId: optId,
  configurationItemId: optId,
});
const replySchema = z.object({ body: z.string().trim().min(1, 'Required').max(20000) });
const accessSchema = z.object({
  enabled: z.boolean(),
  resetPassword: z.boolean().default(false),
  role: z.enum(PORTAL_ROLES).optional(),
  /** E-mail the contact a link to choose their own password (valid 7 days) instead of returning one. */
  sendInvite: z.boolean().default(false),
});
const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email() });
const passwordRule = z.string().min(10, 'Use at least 10 characters').max(256);
const resetSchema = z.object({ token: z.string().min(20).max(200), password: passwordRule });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordRule });
const docSchema = z.object({ title: z.string().trim().min(2, 'Give the page a title').max(255), body: z.string().max(200000).default('') });

const BLOCKED_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.js', '.jar', '.dll', '.sh', '.hta', '.html', '.htm', '.svg']);
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

/** Issues a password token for a portal contact (only the hash is stored): one hour for a reset, longer for an invitation. */
export async function createPortalResetToken(db: Db, contactId: number, hours = 1): Promise<string> {
  const token = randomToken(32);
  await db
    .update(s.contacts)
    .set({ portalResetTokenHash: sha256(token), portalResetExpiresAt: new Date(Date.now() + hours * 3600_000) })
    .where(eq(s.contacts.id, contactId));
  return token;
}

function contactOf(req: FastifyRequest): PortalContact {
  if (!req.portalContact) throw unauthorized();
  return req.portalContact;
}

/** Tickets visible to a contact: their own, or the whole company for managers. */
const visibleTickets = (c: PortalContact): SQL =>
  c.isManager ? eq(s.tickets.companyId, c.companyId) : and(eq(s.tickets.companyId, c.companyId), eq(s.tickets.contactId, c.id))!;

/** Company documentation shown in the portal: shared by the IT team (public) or written by clients. */
const visibleDocs = (c: PortalContact): SQL =>
  and(
    eq(s.kbArticles.companyId, c.companyId),
    or(and(eq(s.kbArticles.visibility, 'public'), eq(s.kbArticles.status, 'published')), isNotNull(s.kbArticles.portalAuthorContactId)),
  )!;

/** Plain-text preview of a Markdown page (no heading marks, table pipes or separator rows). */
const excerpt = (n: number) => sql<string>`left(trim(regexp_replace(regexp_replace(${s.kbArticles.body}, '-{3,}|[#*_>|\`\\[\\]]', ' ', 'g'), '\\s+', ' ', 'g')), ${sql.raw(String(n))})`;

const staffName = sql<string | null>`nullif(trim(coalesce(${s.users.firstName}, '') || ' ' || coalesce(${s.users.lastName}, '')), '')`;

const baseUrl = (app: FastifyInstance, req: FastifyRequest) => (app.config.PUBLIC_URL ?? `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');

/** Portal invitation / password e-mails, branded like every other e-mail. */
async function sendPortalMail(app: FastifyInstance, to: string, kind: 'invite' | 'reset', vars: { name: string; link: string; base: string }) {
  const smtp = await resolveSmtp(app.db, app.config);
  if (!smtp) return false;
  const settings = await getSystemSettings(app.db);
  const t = mailTranslator(mailLang(settings.language));
  const org = settings.organizationName;
  const invite = kind === 'invite';
  await sendBranded(app.db, app.config, smtp, app.mailTransport ?? transportFor(smtp), to, invite ? t('inviteSubject', { org }) : t('resetSubject'), {
    preheader: invite ? t('inviteP1', { org }) : t('resetP1'),
    heading: invite ? t('inviteHeading') : t('resetHeading'),
    greeting: t('hello', { name: vars.name }),
    paragraphs: invite ? [t('inviteP1', { org }), t('inviteP2', { url: `${vars.base}/portal`, email: to })] : [t('resetP1')],
    button: { label: invite ? t('inviteButton') : t('resetButton'), url: vars.link },
    hint: invite ? undefined : t('resetP2'),
    footer: t('footerClient', { org }),
    signature: { sender: t('team', { org }) },
  });
  return true;
}

export async function portalRoutes(app: FastifyInstance) {
  const ttlHours = app.config.SESSION_TTL_HOURS;
  const root = resolve(app.config.UPLOAD_DIR);
  app.decorateRequest('portalContact', null);

  // Portal authentication + CSRF. Every portal route is "public" for the staff hook.
  app.addHook('onRoute', (route) => {
    route.config = { ...(route.config ?? {}), public: true };
  });

  await app.register(
    async (portal) => {
      let settings: SystemSettings;
      portal.addHook('preHandler', async (req) => {
        settings = await getSystemSettings(app.db);
        const token = req.cookies[PORTAL_COOKIE];
        if (token) {
          const [row] = await app.db
            .select({ session: s.portalSessions, contact: s.contacts })
            .from(s.portalSessions)
            .innerJoin(s.contacts, eq(s.contacts.id, s.portalSessions.contactId))
            .where(and(eq(s.portalSessions.id, sha256(token)), sql`${s.portalSessions.expiresAt} > now()`));
          if (row && row.contact.isActive && row.contact.portalEnabled) {
            req.portalContact = {
              id: row.contact.id,
              companyId: row.contact.companyId,
              firstName: row.contact.firstName,
              lastName: row.contact.lastName,
              email: row.contact.email,
              isManager: row.contact.isPrimary || row.contact.portalRole === 'manager',
              csrfToken: row.session.csrfToken,
              sessionId: row.session.id,
            };
          }
        }
        const path = req.url.split('?')[0]!;
        const open = ['/login', '/forgot-password', '/reset-password', '/info'].some((p) => path.endsWith(p)) || (req.method === 'GET' && path.endsWith('/me'));
        if (open) return;
        if (!req.portalContact) throw unauthorized();
        if (!settings.portalEnabled) throw new AppError(403, 'portal_disabled', 'The client portal is turned off');
        if (!SAFE.has(req.method) && req.headers['x-csrf-token'] !== req.portalContact.csrfToken) throw forbidden('Missing or invalid CSRF token');
      });

      /** Public branding for the sign-in page. */
      portal.get('/info', async () => ({ organizationName: settings.organizationName, logoUpdatedAt: settings.logoUpdatedAt, enabled: settings.portalEnabled, language: settings.language }));

      portal.post('/login', { config: { rateLimit: { max: app.config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (req, reply: FastifyReply) => {
        const input = loginSchema.parse(req.body);
        if (!settings.portalEnabled) throw new AppError(403, 'portal_disabled', 'The client portal is turned off');
        const candidates = await app.db
          .select()
          .from(s.contacts)
          .where(and(sql`lower(${s.contacts.email}) = ${input.email}`, eq(s.contacts.portalEnabled, true), eq(s.contacts.isActive, true)));
        let match: (typeof candidates)[number] | undefined;
        for (const c of candidates) if (c.portalPasswordHash && (await verifyPassword(c.portalPasswordHash, input.password))) match = c;
        if (!candidates.length) await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZGVmYXVsdGhhc2hkZWZhdWx0aGFzaA', input.password);
        if (!match) throw new AppError(401, 'unauthorized', 'Invalid e-mail or password');
        const token = randomToken(32);
        const csrfToken = randomToken(24);
        const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
        await app.db.insert(s.portalSessions).values({ id: sha256(token), contactId: match.id, csrfToken, expiresAt });
        await app.db.update(s.contacts).set({ portalLastLoginAt: new Date() }).where(eq(s.contacts.id, match.id));
        reply.setCookie(PORTAL_COOKIE, token, { path: '/api/portal', httpOnly: true, sameSite: 'lax', secure: app.config.COOKIE_SECURE === 'true' || (app.config.COOKIE_SECURE === 'auto' && req.protocol === 'https'), expires: expiresAt });
        return { ok: true, csrfToken };
      });

      /** Always answers OK so the endpoint cannot be used to discover accounts. */
      portal.post('/forgot-password', { config: { rateLimit: { max: app.config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (req) => {
        const { email } = forgotSchema.parse(req.body);
        const [contact] = await app.db
          .select()
          .from(s.contacts)
          .where(and(sql`lower(${s.contacts.email}) = ${email}`, eq(s.contacts.portalEnabled, true), eq(s.contacts.isActive, true)))
          .limit(1);
        if (contact && (await resolveSmtp(app.db, app.config))) {
          const token = await createPortalResetToken(app.db, contact.id);
          const link = `${baseUrl(app, req)}/portal/reset?token=${encodeURIComponent(token)}`;
          await sendPortalMail(app, contact.email!, 'reset', { name: contact.firstName, link, base: baseUrl(app, req) }).catch((err: Error) => req.log.warn({ err: err.message }, 'portal reset e-mail failed'));
        }
        return { ok: true };
      });

      portal.post('/reset-password', { config: { rateLimit: { max: app.config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (req) => {
        const input = resetSchema.parse(req.body);
        const [contact] = await app.db
          .select({ id: s.contacts.id })
          .from(s.contacts)
          .where(and(eq(s.contacts.portalResetTokenHash, sha256(input.token)), sql`${s.contacts.portalResetExpiresAt} > now()`, eq(s.contacts.portalEnabled, true)));
        if (!contact) throw badRequest('This link is invalid or has expired');
        await app.db
          .update(s.contacts)
          .set({ portalPasswordHash: await hashPassword(input.password), portalResetTokenHash: null, portalResetExpiresAt: null })
          .where(eq(s.contacts.id, contact.id));
        await app.db.delete(s.portalSessions).where(eq(s.portalSessions.contactId, contact.id));
        return { ok: true };
      });

      portal.post('/logout', async (req, reply) => {
        const c = contactOf(req);
        await app.db.delete(s.portalSessions).where(eq(s.portalSessions.id, c.sessionId));
        reply.clearCookie(PORTAL_COOKIE, { path: '/api/portal' });
        return { ok: true };
      });

      portal.get('/me', async (req) => {
        const branding = { organizationName: settings.organizationName, logoUpdatedAt: settings.logoUpdatedAt, language: settings.language };
        if (!req.portalContact || !settings.portalEnabled) return { contact: null, ...branding };
        const c = req.portalContact;
        const [co] = await app.db.select({ name: s.companies.name }).from(s.companies).where(eq(s.companies.id, c.companyId));
        const [logo] = await app.db
          .select({ updatedAt: s.logos.updatedAt })
          .from(s.logos)
          .where(and(eq(s.logos.entityType, 'company'), eq(s.logos.entityId, c.companyId)));
        return {
          contact: {
            id: c.id,
            firstName: c.firstName,
            lastName: c.lastName,
            email: c.email,
            companyId: c.companyId,
            companyName: co?.name ?? '',
            companyLogoUpdatedAt: logo?.updatedAt ?? null,
            isManager: c.isManager,
            // Kept for older clients of this endpoint.
            seesCompanyTickets: c.isManager,
          },
          features: {
            time: settings.portalShowTime,
            devices: settings.portalShowDevices,
            contracts: settings.portalShowContracts && c.isManager,
            docs: settings.portalAllowDocs,
            priority: settings.portalAllowPriority,
            attachments: settings.portalAllowAttachments,
            reports: settings.portalShowReports && c.isManager,
            billing: settings.portalShowBilling && c.isManager,
          },
          welcome: settings.portalWelcome,
          ...branding,
          csrfToken: c.csrfToken,
        };
      });

      /* -------------------------------------------------------------- home */

      portal.get('/dashboard', async (req) => {
        const c = contactOf(req);
        const vis = visibleTickets(c);
        const [counts] = await app.db
          .select({
            open: sql<number>`count(*) filter (where ${s.ticketStatuses.category} in ('new','open'))::int`,
            waiting: sql<number>`count(*) filter (where ${s.ticketStatuses.category} = 'waiting')::int`,
            resolved30: sql<number>`count(*) filter (where ${s.ticketStatuses.category} in ('resolved','closed') and ${s.tickets.resolvedAt} > now() - interval '30 days')::int`,
            total: sql<number>`count(*)::int`,
          })
          .from(s.tickets)
          .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
          .where(vis);
        let minutesMonth = 0;
        if (settings.portalShowTime) {
          const tz = settings.timezone;
          const [m] = await app.db
            .select({ n: sql<number>`coalesce(sum(${s.timeEntries.durationMinutes}), 0)::int` })
            .from(s.timeEntries)
            .innerJoin(s.tickets, eq(s.tickets.id, s.timeEntries.ticketId))
            .where(
              and(
                vis,
                inArray(s.timeEntries.status, COUNTED_STATUSES),
                sql`date_trunc('month', ${s.timeEntries.startedAt} at time zone ${tz}) = date_trunc('month', now() at time zone ${tz})`,
              ),
            );
          minutesMonth = m?.n ?? 0;
        }
        const recent = await ticketRows(c, { state: 'all', limit: 6 });
        const [docs] = settings.portalAllowDocs
          ? await app.db.select({ n: sql<number>`count(*)::int` }).from(s.kbArticles).where(visibleDocs(c))
          : [{ n: 0 }];
        return { counts: { ...counts!, minutesMonth, docs: docs?.n ?? 0 }, recent };
      });

      /* ----------------------------------------------------------- tickets */

      async function ticketRows(c: PortalContact, opts: { state?: string; q?: string; limit?: number }) {
        const q = opts.q?.trim();
        const term = q ? likeTerm(q) : null;
        const state = opts.state ?? 'open';
        return app.db
          .select({
            id: s.tickets.id,
            ticketNumber: s.tickets.ticketNumber,
            title: s.tickets.title,
            statusName: s.ticketStatuses.name,
            statusColor: s.ticketStatuses.color,
            statusCategory: s.ticketStatuses.category,
            priorityName: s.ticketPriorities.name,
            priorityColor: s.ticketPriorities.color,
            contactName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
            assignedName: staffName,
            createdAt: s.tickets.createdAt,
            lastActivityAt: s.tickets.lastActivityAt,
            resolvedAt: s.tickets.resolvedAt,
            workedMinutes: settings.portalShowTime
              ? sql<number>`(select coalesce(sum(te.duration_minutes), 0)::int from time_entries te where te.ticket_id = ${s.tickets.id} and te.status in ('submitted','approved','billed'))`
              : sql<number>`0`,
          })
          .from(s.tickets)
          .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
          .innerJoin(s.ticketPriorities, eq(s.ticketPriorities.id, s.tickets.priorityId))
          .leftJoin(s.contacts, eq(s.contacts.id, s.tickets.contactId))
          .leftJoin(s.users, eq(s.users.id, s.tickets.assignedUserId))
          .where(
            and(
              visibleTickets(c),
              state === 'closed'
                ? inArray(s.ticketStatuses.category, ['resolved', 'closed'])
                : state === 'waiting'
                  ? eq(s.ticketStatuses.category, 'waiting')
                  : state === 'all'
                    ? undefined
                    : sql`${s.ticketStatuses.category} not in ('resolved','closed')`,
              term ? or(sql`${s.tickets.title} ilike ${term}`, sql`${s.tickets.ticketNumber} ilike ${term}`, sql`${s.tickets.description} ilike ${term}`) : undefined,
            ),
          )
          .orderBy(desc(s.tickets.lastActivityAt))
          .limit(opts.limit ?? 300);
      }

      portal.get('/tickets', async (req) => {
        const c = contactOf(req);
        const q = req.query as { state?: string; q?: string };
        return { data: await ticketRows(c, { state: q.state, q: q.q }) };
      });

      /** Picklists for the new-request form. */
      portal.get('/options', async (req) => {
        const c = contactOf(req);
        const priorities = settings.portalAllowPriority
          ? await app.db
              .select({ id: s.ticketPriorities.id, name: s.ticketPriorities.name, color: s.ticketPriorities.color, isDefault: s.ticketPriorities.isDefault })
              .from(s.ticketPriorities)
              .where(eq(s.ticketPriorities.isActive, true))
              .orderBy(asc(s.ticketPriorities.sortOrder))
          : [];
        const devices = await deviceRows(c, true);
        return { priorities, devices: devices.map((d) => ({ id: d.id, name: d.name, typeName: d.typeName, mine: d.mine })) };
      });

      const loadTicket = async (c: PortalContact, id: number) => {
        const [t] = await app.db
          .select({
            id: s.tickets.id,
            ticketNumber: s.tickets.ticketNumber,
            title: s.tickets.title,
            description: s.tickets.description,
            statusName: s.ticketStatuses.name,
            statusColor: s.ticketStatuses.color,
            statusCategory: s.ticketStatuses.category,
            priorityName: s.ticketPriorities.name,
            priorityColor: s.ticketPriorities.color,
            resolution: s.tickets.resolution,
            contactName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
            assignedName: staffName,
            configurationItemId: s.tickets.configurationItemId,
            createdAt: s.tickets.createdAt,
            lastActivityAt: s.tickets.lastActivityAt,
            resolvedAt: s.tickets.resolvedAt,
          })
          .from(s.tickets)
          .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
          .innerJoin(s.ticketPriorities, eq(s.ticketPriorities.id, s.tickets.priorityId))
          .leftJoin(s.contacts, eq(s.contacts.id, s.tickets.contactId))
          .leftJoin(s.users, eq(s.users.id, s.tickets.assignedUserId))
          .where(and(eq(s.tickets.id, id), visibleTickets(c)));
        if (!t) throw notFound('Ticket');
        return t;
      };

      portal.get('/tickets/:id', async (req) => {
        const c = contactOf(req);
        const t = await loadTicket(c, idOf(req));
        const notes = await app.db
          .select({
            id: s.ticketNotes.id,
            body: s.ticketNotes.body,
            kind: s.ticketNotes.kind,
            createdAt: s.ticketNotes.createdAt,
            author: staffName,
          })
          .from(s.ticketNotes)
          .leftJoin(s.users, eq(s.users.id, s.ticketNotes.userId))
          .where(and(eq(s.ticketNotes.ticketId, t.id), eq(s.ticketNotes.visibility, 'public')))
          .orderBy(asc(s.ticketNotes.createdAt));
        const time = settings.portalShowTime
          ? await app.db
              .select({ id: s.timeEntries.id, startedAt: s.timeEntries.startedAt, minutes: s.timeEntries.durationMinutes, description: s.timeEntries.description, technician: staffName })
              .from(s.timeEntries)
              .leftJoin(s.users, eq(s.users.id, s.timeEntries.userId))
              .where(and(eq(s.timeEntries.ticketId, t.id), inArray(s.timeEntries.status, COUNTED_STATUSES)))
              .orderBy(desc(s.timeEntries.startedAt))
          : [];
        const files = await app.db
          .select({ id: s.attachments.id, fileName: s.attachments.fileName, mimeType: s.attachments.mimeType, sizeBytes: s.attachments.sizeBytes, createdAt: s.attachments.createdAt, uploadedByContactId: s.attachments.uploadedByContactId })
          .from(s.attachments)
          .where(and(eq(s.attachments.entityType, 'ticket'), eq(s.attachments.entityId, t.id), eq(s.attachments.portalVisible, true)))
          .orderBy(desc(s.attachments.createdAt));
        const [device] = t.configurationItemId ? await app.db.select({ name: s.configurationItems.name }).from(s.configurationItems).where(eq(s.configurationItems.id, t.configurationItemId)) : [];
        // Pasted images are served through the portal (see below) instead of the staff attachment URL.
        return {
          ...t,
          configurationItemId: undefined,
          deviceName: device?.name ?? null,
          description: portalImageUrls(t.description, t.id),
          resolution: portalImageUrls(t.resolution, t.id),
          notes: notes.map((n) => ({ ...n, kind: undefined, body: portalImageUrls(n.body, t.id)!, fromCustomer: n.kind === 'portal' || n.kind === 'email', author: n.author ?? null })),
          workedMinutes: time.reduce((a, e) => a + e.minutes, 0),
          timeEntries: time,
          files: files.map((f) => ({ ...f, uploadedByContactId: undefined, fromClient: f.uploadedByContactId !== null })),
        };
      });

      /**
       * An image pasted into the description, resolution or a customer-visible
       * note of the contact's ticket. Other attachments (and images only used in
       * internal notes or time entries) are never served this way.
       */
      portal.get('/tickets/:id/images/:fileId', async (req, reply) => {
        const c = contactOf(req);
        const t = await loadTicket(c, idOf(req));
        const fileId = idOf(req, 'fileId');
        const [file] = await app.db
          .select()
          .from(s.attachments)
          .where(and(eq(s.attachments.id, fileId), eq(s.attachments.entityType, 'ticket'), eq(s.attachments.entityId, t.id)));
        if (!file || !INLINE_IMAGE_TYPES.has(file.mimeType)) throw notFound('Image');
        const publicNotes = await app.db
          .select({ body: s.ticketNotes.body })
          .from(s.ticketNotes)
          .where(and(eq(s.ticketNotes.ticketId, t.id), eq(s.ticketNotes.visibility, 'public')));
        const referenced = [t.description, t.resolution, ...publicNotes.map((n) => n.body)].some((text) => noteImageIds(text).includes(fileId));
        if (!referenced && !file.portalVisible) throw notFound('Image');
        return sendFile(reply, file, true, 'private, max-age=3600');
      });

      /** A file shared with the client (uploaded by them, or marked "visible to client" by the IT team). */
      portal.get('/tickets/:id/files/:fileId', async (req, reply) => {
        const c = contactOf(req);
        const t = await loadTicket(c, idOf(req));
        const [file] = await app.db
          .select()
          .from(s.attachments)
          .where(and(eq(s.attachments.id, idOf(req, 'fileId')), eq(s.attachments.entityType, 'ticket'), eq(s.attachments.entityId, t.id), eq(s.attachments.portalVisible, true)));
        if (!file) throw notFound('File');
        return sendFile(reply, file, (req.query as { inline?: string }).inline === 'true' && INLINE_SAFE.has(file.mimeType));
      });

      async function sendFile(reply: FastifyReply, file: typeof s.attachments.$inferSelect, inline: boolean, cache = 'private, no-store') {
        const path = join(root, file.storageKey);
        if (!path.startsWith(root)) throw notFound('File');
        await stat(path).catch(() => {
          throw notFound('File');
        });
        return reply
          .header('content-type', INLINE_SAFE.has(file.mimeType) ? file.mimeType : 'application/octet-stream')
          .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
          .header('cache-control', cache)
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .send(createReadStream(path));
      }

      portal.post('/tickets/:id/files', async (req, reply) => {
        const c = contactOf(req);
        if (!settings.portalAllowAttachments) throw forbidden('Attaching files is turned off');
        const t = await loadTicket(c, idOf(req));
        const saved: { id: number; fileName: string }[] = [];
        await mkdir(root, { recursive: true });
        for await (const part of req.files()) {
          const name = part.filename.replace(/[\\/\0]/g, '_').slice(0, 200) || 'file';
          const ext = extname(name).toLowerCase();
          if (BLOCKED_EXT.has(ext)) throw badRequest(`Files of type ${ext} are not allowed`);
          const buf = await part.toBuffer();
          if (part.file.truncated) throw badRequest(`File exceeds the ${app.config.MAX_UPLOAD_MB} MB limit`);
          const key = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}${ext}`;
          const path = join(root, key);
          if (!path.startsWith(root)) throw badRequest('Invalid file name');
          await mkdir(join(root, key.split('/')[0]!), { recursive: true });
          await writeFile(path, buf, { flag: 'wx' });
          const [row] = await app.db
            .insert(s.attachments)
            .values({
              entityType: 'ticket',
              entityId: t.id,
              fileName: name,
              mimeType: part.mimetype || 'application/octet-stream',
              sizeBytes: buf.length,
              storageKey: key,
              sha256: createHash('sha256').update(buf).digest('hex'),
              uploadedByContactId: c.id,
              portalVisible: true,
            })
            .returning();
          await app.db.insert(s.ticketEvents).values({ ticketId: t.id, userId: null, type: 'attachment_added', data: { fileName: name, byContact: `${c.firstName} ${c.lastName}` } });
          saved.push({ id: row!.id, fileName: name });
        }
        if (!saved.length) throw badRequest('No file received');
        await app.db.update(s.tickets).set({ lastActivityAt: new Date() }).where(eq(s.tickets.id, t.id));
        await audit(app.db, req, { action: 'create', entityType: 'attachment', entityId: saved[0]!.id, summary: `${saved.map((f) => f.fileName).join(', ')} on ticket ${t.ticketNumber} via client portal` }, null);
        return reply.status(201).send({ data: saved });
      });

      portal.post('/tickets', async (req, reply) => {
        const c = contactOf(req);
        const input = ticketSchema.parse(req.body);
        const [source] = await app.db.select({ id: s.ticketSources.id }).from(s.ticketSources).where(sql`lower(${s.ticketSources.name}) = 'portal'`);
        let priorityId: number | null = null;
        if (input.priorityId && settings.portalAllowPriority) {
          const [p] = await app.db.select({ id: s.ticketPriorities.id }).from(s.ticketPriorities).where(and(eq(s.ticketPriorities.id, input.priorityId), eq(s.ticketPriorities.isActive, true)));
          if (!p) throw badRequest('Unknown priority');
          priorityId = p.id;
        }
        let configurationItemId: number | null = null;
        if (input.configurationItemId) {
          const devices = await deviceRows(c, true);
          if (!devices.some((d) => d.id === input.configurationItemId)) throw badRequest('Unknown device');
          configurationItemId = input.configurationItemId;
        }
        const ticket = await app.db.transaction((tx) =>
          createTicket(
            { db: tx, userId: null },
            { title: input.title, description: input.description, companyId: c.companyId, contactId: c.id, sourceId: source?.id ?? null, priorityId, configurationItemId },
          ),
        );
        await audit(app.db, req, { action: 'create', entityType: 'ticket', entityId: ticket.id, summary: `${ticket.ticketNumber} via client portal` }, null);
        await runTicketRules(app.db, 'ticket.created', ticket.id);
        return reply.status(201).send({ id: ticket.id, ticketNumber: ticket.ticketNumber });
      });

      portal.post('/tickets/:id/replies', async (req, reply) => {
        const c = contactOf(req);
        const t = await loadTicket(c, idOf(req));
        const input = replySchema.parse(req.body);
        const note = await app.db.transaction(async (tx) => {
          const n = await addTicketNote({ db: tx, userId: null }, t.id, { body: `${c.firstName} ${c.lastName} wrote:\n\n${input.body}`, visibility: 'public', kind: 'portal' });
          if (['waiting', 'resolved'].includes(t.statusCategory)) {
            const [open] = await tx
              .select({ id: s.ticketStatuses.id })
              .from(s.ticketStatuses)
              .where(and(eq(s.ticketStatuses.category, 'open'), eq(s.ticketStatuses.isActive, true)))
              .orderBy(asc(s.ticketStatuses.sortOrder))
              .limit(1);
            if (open) await updateTicket({ db: tx, userId: null }, t.id, { statusId: open.id });
          }
          return n;
        });
        await runTicketRules(app.db, 'ticket.updated', t.id);
        await enqueue(app.db, 'email.client_reply', { noteId: note.id }, { maxAttempts: 3 });
        return reply.status(201).send({ ok: true });
      });

      /* -------------------------------------------------------------- work */

      /** Time spent by the IT team on the contact's (or, for managers, the company's) tickets. */
      portal.get('/work', async (req) => {
        const c = contactOf(req);
        if (!settings.portalShowTime) throw forbidden('Work details are not shared in this portal');
        const tz = settings.timezone;
        const q = req.query as { month?: string };
        const month = /^\d{4}-\d{2}$/.test(q.month ?? '') ? q.month! : null;
        const vis = and(visibleTickets(c), inArray(s.timeEntries.status, COUNTED_STATUSES));
        const months = await app.db
          .select({
            month: sql<string>`to_char(${s.timeEntries.startedAt} at time zone ${tz}, 'YYYY-MM')`,
            minutes: sql<number>`sum(${s.timeEntries.durationMinutes})::int`,
            tickets: sql<number>`count(distinct ${s.timeEntries.ticketId})::int`,
          })
          .from(s.timeEntries)
          .innerJoin(s.tickets, eq(s.tickets.id, s.timeEntries.ticketId))
          .where(and(vis, sql`${s.timeEntries.startedAt} >= date_trunc('month', now() at time zone ${tz}) - interval '11 months'`))
          .groupBy(sql`1`)
          .orderBy(sql`1`);
        const entries = await app.db
          .select({
            id: s.timeEntries.id,
            startedAt: s.timeEntries.startedAt,
            minutes: s.timeEntries.durationMinutes,
            description: s.timeEntries.description,
            technician: staffName,
            ticketId: s.tickets.id,
            ticketNumber: s.tickets.ticketNumber,
            ticketTitle: s.tickets.title,
          })
          .from(s.timeEntries)
          .innerJoin(s.tickets, eq(s.tickets.id, s.timeEntries.ticketId))
          .leftJoin(s.users, eq(s.users.id, s.timeEntries.userId))
          .where(and(vis, month ? sql`to_char(${s.timeEntries.startedAt} at time zone ${tz}, 'YYYY-MM') = ${month}` : sql`${s.timeEntries.startedAt} > now() - interval '90 days'`))
          .orderBy(desc(s.timeEntries.startedAt))
          .limit(500);
        let contracts: unknown[] = [];
        if (c.isManager && settings.portalShowContracts) {
          const rows = await app.db
            .select({ id: s.contracts.id, name: s.contracts.name, contractNumber: s.contracts.contractNumber, type: s.contracts.type, status: s.contracts.status, startDate: s.contracts.startDate, endDate: s.contracts.endDate })
            .from(s.contracts)
            .where(and(eq(s.contracts.companyId, c.companyId), eq(s.contracts.status, 'active'), eq(s.contracts.portalVisible, true)))
            .orderBy(asc(s.contracts.name));
          const balances = await contractBalances(app.db, rows.map((r) => r.id));
          contracts = rows.map((r) => {
            const b = balances.get(r.id);
            return {
              ...r,
              purchasedHours: b?.purchasedHours ?? 0,
              usedHours: b ? (b.purchasedHours > 0 ? b.usedHours : Math.round((b.loggedMinutes / 60) * 100) / 100) : 0,
              remainingHours: b?.remainingHours ?? 0,
              lowBalance: b?.lowBalance ?? false,
              blocks: (b?.blocks ?? []).map((x) => ({ id: x.id, hours: x.hours, usedHours: x.usedHours, remainingHours: x.remainingHours, startDate: x.startDate, endDate: x.endDate, expired: x.expired })),
            };
          });
        }
        return { months, entries, contracts, month };
      });

      /* ----------------------------------------------------------- devices */

      async function deviceRows(c: PortalContact, activeOnly = false) {
        return app.db
          .select({
            id: s.configurationItems.id,
            name: s.configurationItems.name,
            typeName: s.ciTypes.name,
            serialNumber: s.configurationItems.serialNumber,
            hostname: s.configurationItems.hostname,
            osName: s.configurationItems.osName,
            warrantyExpiresAt: s.configurationItems.warrantyExpiresAt,
            lifecycleStatus: s.configurationItems.lifecycleStatus,
            userName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
            mine: sql<boolean>`coalesce(${s.configurationItems.contactId} = ${c.id}, false)`,
            openTickets: sql<number>`(select count(*)::int from tickets t join ticket_statuses ts on ts.id = t.status_id where t.configuration_item_id = ${s.configurationItems.id} and ts.category not in ('resolved','closed'))`,
          })
          .from(s.configurationItems)
          .leftJoin(s.ciTypes, eq(s.ciTypes.id, s.configurationItems.ciTypeId))
          .leftJoin(s.contacts, eq(s.contacts.id, s.configurationItems.contactId))
          .where(
            and(
              eq(s.configurationItems.companyId, c.companyId),
              c.isManager ? undefined : eq(s.configurationItems.contactId, c.id),
              activeOnly ? eq(s.configurationItems.lifecycleStatus, 'active') : undefined,
            ),
          )
          .orderBy(sql`coalesce(${s.configurationItems.contactId} = ${c.id}, false) desc`, asc(s.configurationItems.name))
          .limit(1000);
      }

      portal.get('/devices', async (req) => {
        const c = contactOf(req);
        if (!settings.portalShowDevices) throw forbidden('Devices are not shared in this portal');
        return { data: await deviceRows(c) };
      });

      /* ----------------------------------------------------- documentation */

      const docFields = {
        id: s.kbArticles.id,
        title: s.kbArticles.title,
        updatedAt: s.kbArticles.updatedAt,
        createdAt: s.kbArticles.createdAt,
        byClient: sql<boolean>`${s.kbArticles.portalAuthorContactId} is not null`,
        authorName: sql<string | null>`coalesce((select c.first_name || ' ' || c.last_name from contacts c where c.id = ${s.kbArticles.portalAuthorContactId}), (select u.first_name || ' ' || u.last_name from users u where u.id = ${s.kbArticles.authorId}))`,
        updatedByName: sql<string | null>`(select c.first_name || ' ' || c.last_name from contacts c where c.id = ${s.kbArticles.portalUpdatedByContactId})`,
      };

      const assertDocs = () => {
        if (!settings.portalAllowDocs) throw forbidden('Documentation is turned off in this portal');
      };

      portal.get('/docs', async (req) => {
        const c = contactOf(req);
        assertDocs();
        const q = String((req.query as { q?: string }).q ?? '').trim();
        const rows = await app.db
          .select({ ...docFields, excerpt: excerpt(200) })
          .from(s.kbArticles)
          .where(and(visibleDocs(c), q ? or(sql`${s.kbArticles.title} ilike ${likeTerm(q)}`, sql`${s.kbArticles.body} ilike ${likeTerm(q)}`) : undefined))
          .orderBy(asc(sql`lower(${s.kbArticles.title})`))
          .limit(500);
        return { data: rows };
      });

      const loadDoc = async (c: PortalContact, id: number) => {
        const [d] = await app.db
          .select({ ...docFields, body: s.kbArticles.body })
          .from(s.kbArticles)
          .where(and(eq(s.kbArticles.id, id), visibleDocs(c)));
        if (!d) throw notFound('Page');
        return d;
      };

      portal.get('/docs/:id', async (req) => {
        const c = contactOf(req);
        assertDocs();
        const d = await loadDoc(c, idOf(req));
        // Pages written by the IT team are read-only in the portal.
        return { ...d, canEdit: d.byClient };
      });

      portal.post('/docs', async (req, reply) => {
        const c = contactOf(req);
        assertDocs();
        const input = docSchema.parse(req.body);
        const row = await app.db.transaction(async (tx) => {
          const st = await getSystemSettings(tx);
          const [r] = await tx
            .insert(s.kbArticles)
            .values({
              title: input.title,
              body: input.body,
              companyId: c.companyId,
              articleNumber: formatNumber(st.kbPrefix, await nextSequence(tx, 'kb')),
              visibility: 'public',
              status: 'published',
              publishedAt: new Date(),
              tags: ['client'],
              portalAuthorContactId: c.id,
              portalUpdatedByContactId: c.id,
            })
            .returning({ id: s.kbArticles.id });
          return r!;
        });
        await audit(app.db, req, { action: 'create', entityType: 'kb_article', entityId: row.id, summary: `${input.title} (client documentation by ${c.firstName} ${c.lastName})` }, null);
        return reply.status(201).send(row);
      });

      portal.patch('/docs/:id', async (req) => {
        const c = contactOf(req);
        assertDocs();
        const d = await loadDoc(c, idOf(req));
        if (!d.byClient) throw forbidden('Pages written by the IT team cannot be changed here');
        const input = docSchema.partial().parse(req.body);
        await app.db
          .update(s.kbArticles)
          .set({ ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}), portalUpdatedByContactId: c.id })
          .where(eq(s.kbArticles.id, d.id));
        await audit(app.db, req, { action: 'update', entityType: 'kb_article', entityId: d.id, summary: `${input.title ?? d.title} (client documentation by ${c.firstName} ${c.lastName})` }, null);
        return { ok: true };
      });

      portal.delete('/docs/:id', async (req) => {
        const c = contactOf(req);
        assertDocs();
        const d = await loadDoc(c, idOf(req));
        if (!d.byClient) throw forbidden('Pages written by the IT team cannot be deleted here');
        const [own] = await app.db.select({ id: s.kbArticles.id }).from(s.kbArticles).where(and(eq(s.kbArticles.id, d.id), eq(s.kbArticles.portalAuthorContactId, c.id)));
        if (!own && !c.isManager) throw forbidden('Only the author or a portal manager can delete this page');
        await app.db.delete(s.kbArticles).where(eq(s.kbArticles.id, d.id));
        await audit(app.db, req, { action: 'delete', entityType: 'kb_article', entityId: d.id, summary: `${d.title} (client documentation, by ${c.firstName} ${c.lastName})` }, null);
        return { ok: true };
      });

      /* ---------------------------------------------------- knowledge base */

      portal.get('/kb', async (req) => {
        contactOf(req);
        const q = String((req.query as { q?: string }).q ?? '').trim();
        const rows = await app.db
          .select({ id: s.kbArticles.id, title: s.kbArticles.title, excerpt: excerpt(240), updatedAt: s.kbArticles.updatedAt })
          .from(s.kbArticles)
          .where(
            and(
              eq(s.kbArticles.visibility, 'public'),
              eq(s.kbArticles.status, 'published'),
              isNull(s.kbArticles.companyId),
              q ? or(sql`${s.kbArticles.title} ilike ${likeTerm(q)}`, sql`${s.kbArticles.body} ilike ${likeTerm(q)}`) : undefined,
            ),
          )
          .orderBy(desc(s.kbArticles.updatedAt))
          .limit(100);
        return { data: rows };
      });

      portal.get('/kb/:id', async (req) => {
        const c = contactOf(req);
        const [a] = await app.db
          .select({ id: s.kbArticles.id, title: s.kbArticles.title, body: s.kbArticles.body, updatedAt: s.kbArticles.updatedAt })
          .from(s.kbArticles)
          .where(and(eq(s.kbArticles.id, idOf(req)), eq(s.kbArticles.visibility, 'public'), eq(s.kbArticles.status, 'published'), or(isNull(s.kbArticles.companyId), eq(s.kbArticles.companyId, c.companyId))));
        if (!a) throw notFound('Article');
        return a;
      });

      /* ----------------------------------------------------------- profile */

      portal.get('/profile', async (req) => {
        const c = contactOf(req);
        const [row] = await app.db
          .select({ firstName: s.contacts.firstName, lastName: s.contacts.lastName, email: s.contacts.email, phone: s.contacts.phone, mobile: s.contacts.mobile, title: s.contacts.title, lastLoginAt: s.contacts.portalLastLoginAt })
          .from(s.contacts)
          .where(eq(s.contacts.id, c.id));
        const colleagues = c.isManager
          ? await app.db
              .select({ id: s.contacts.id, name: sql<string>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`, email: s.contacts.email, portalEnabled: s.contacts.portalEnabled })
              .from(s.contacts)
              .where(and(eq(s.contacts.companyId, c.companyId), eq(s.contacts.isActive, true)))
              .orderBy(asc(s.contacts.lastName))
          : [];
        return { ...row, isManager: c.isManager, colleagues };
      });

      portal.post('/profile/password', { config: { rateLimit: { max: app.config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } }, async (req) => {
        const c = contactOf(req);
        const input = changePasswordSchema.parse(req.body);
        const [row] = await app.db.select({ hash: s.contacts.portalPasswordHash }).from(s.contacts).where(eq(s.contacts.id, c.id));
        if (!row?.hash || !(await verifyPassword(row.hash, input.currentPassword))) throw badRequest('The current password is not correct');
        await app.db.update(s.contacts).set({ portalPasswordHash: await hashPassword(input.newPassword) }).where(eq(s.contacts.id, c.id));
        // Sign out every other session of this contact.
        await app.db.delete(s.portalSessions).where(and(eq(s.portalSessions.contactId, c.id), sql`${s.portalSessions.id} <> ${c.sessionId}`));
        return { ok: true };
      });

      registerPortalEngagement(portal, app, { contactOf, settings: () => settings, visibleTickets });
    },
    { prefix: '/api/portal' },
  );
}

/** Staff endpoints: client portal access per contact, the list of portal users, attachment sharing. */
export async function portalAdminRoutes(app: FastifyInstance) {
  app.post('/contacts/:id/portal', { config: { perm: 'companies.write' } }, async (req) => {
    const id = idOf(req);
    const input = accessSchema.parse(req.body);
    const [contact] = await app.db.select().from(s.contacts).where(eq(s.contacts.id, id));
    if (!contact) throw notFound('Contact');
    if (input.enabled && !contact.email) throw badRequest('The contact needs an e-mail address to sign in to the client portal');
    let password: string | null = null;
    let invited = false;
    const data: Partial<typeof contact> = { portalEnabled: input.enabled };
    if (input.role) data.portalRole = input.role;
    if (input.enabled && input.sendInvite) {
      if (!(await resolveSmtp(app.db, app.config))) throw badRequest('E-mail is not configured: set it up in Administration → E-mail, or share a generated password instead');
    } else if (input.enabled && (input.resetPassword || !contact.portalPasswordHash)) {
      password = `${randomToken(9)}-${randomToken(6)}`;
      data.portalPasswordHash = await hashPassword(password);
    }
    await app.db.update(s.contacts).set(data).where(eq(s.contacts.id, id));
    if (!input.enabled || password) await app.db.delete(s.portalSessions).where(eq(s.portalSessions.contactId, id));
    if (input.enabled && input.sendInvite) {
      const token = await createPortalResetToken(app.db, id, 24 * 7);
      const settings = await getSystemSettings(app.db);
      const base = baseUrl(app, req);
      const link = `${base}/portal/reset?token=${encodeURIComponent(token)}&invite=1`;
      await sendPortalMail(app, contact.email!, 'invite', { name: contact.firstName, link, base });
      invited = true;
    }
    const summary = !input.enabled
      ? 'Client portal access disabled'
      : invited
        ? 'Client portal invitation sent'
        : password
          ? 'Client portal access granted / password reset'
          : input.role
            ? `Client portal role: ${input.role}`
            : 'Client portal access enabled';
    await audit(app.db, req, { action: 'update', entityType: 'contact', entityId: id, summary });
    // A generated password is returned once so staff can share it securely.
    return { enabled: input.enabled, role: data.portalRole ?? contact.portalRole, password, invited };
  });

  /** Every contact with client portal access (Administration → Client portal). */
  app.get('/portal/users', { config: { perm: 'companies.read' } }, async () => {
    const rows = await app.db
      .select({
        id: s.contacts.id,
        firstName: s.contacts.firstName,
        lastName: s.contacts.lastName,
        email: s.contacts.email,
        companyId: s.contacts.companyId,
        companyName: s.companies.name,
        isPrimary: s.contacts.isPrimary,
        isActive: s.contacts.isActive,
        portalRole: s.contacts.portalRole,
        portalLastLoginAt: s.contacts.portalLastLoginAt,
        invitePending: sql<boolean>`${s.contacts.portalPasswordHash} is null`,
      })
      .from(s.contacts)
      .innerJoin(s.companies, eq(s.companies.id, s.contacts.companyId))
      .where(eq(s.contacts.portalEnabled, true))
      .orderBy(asc(s.companies.name), asc(s.contacts.lastName));
    const [activity] = await app.db
      .select({
        tickets30: sql<number>`(select count(*)::int from tickets t join ticket_sources ts on ts.id = t.source_id where lower(ts.name) = 'portal' and t.created_at > now() - interval '30 days')`,
        docs: sql<number>`(select count(*)::int from kb_articles where portal_author_contact_id is not null)`,
      })
      .from(sql`(select 1) x`);
    return { data: rows, stats: activity };
  });

  /** Share (or stop sharing) a ticket attachment with the client portal. */
  app.patch('/attachments/file/:id/portal', { config: { perm: 'tickets.write' } }, async (req) => {
    const id = idOf(req);
    const { portalVisible } = z.object({ portalVisible: z.boolean() }).parse(req.body);
    const [file] = await app.db.select().from(s.attachments).where(eq(s.attachments.id, id));
    if (!file || file.entityType !== 'ticket') throw notFound('Attachment');
    if (file.uploadedByContactId && !portalVisible) throw badRequest('Files uploaded by the client always stay visible to them');
    await app.db.update(s.attachments).set({ portalVisible }).where(eq(s.attachments.id, id));
    await audit(app.db, req, { action: 'update', entityType: 'attachment', entityId: id, summary: `${file.fileName}: ${portalVisible ? 'shared with' : 'hidden from'} the client portal` });
    return { ok: true, portalVisible };
  });
}

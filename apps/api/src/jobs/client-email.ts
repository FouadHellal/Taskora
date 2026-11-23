/**
 * Proactive e-mails: alerts to the IT team about new tickets and client
 * replies, and branded HTML e-mails to clients (request received, reply,
 * resolved, monthly report). Everything goes out through the one mailbox of
 * Administration → E-mail. Clients choose what they receive and where (their
 * main address, a second mailbox or both) in the portal (My account);
 * Administration → Client portal sets the IT addresses and the master
 * switches. Every send is recorded as a ticket event so a retried job never
 * mails the same person twice.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import { noteImagesToText } from '@taskora/shared';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import * as s from '../db/schema/index.js';
import { getSystemSettings, type SystemSettings } from '../lib/settings.js';
import { parseAddresses, resolveSmtp, transportFor, type SmtpSettings } from '../lib/mail.js';
import { loadMailBrand, logoAttachment, renderEmail, type EmailContent, type MailBrand } from '../lib/mail-template.js';
import { mailLang, mailTranslator, type MailT } from './mail-i18n.js';

export { escapeHtml, renderEmail, type EmailContent } from '../lib/mail-template.js';

/* ------------------------------------------------------------ preferences */

export const EMAIL_PREF_KEYS = ['ticketCreated', 'ticketReplies', 'ticketResolved', 'monthlyReport', 'companyTickets'] as const;
export type EmailPrefKey = (typeof EMAIL_PREF_KEYS)[number];
export const EMAIL_PREF_DEFAULTS: Record<EmailPrefKey, boolean> = {
  ticketCreated: true,
  ticketReplies: true,
  ticketResolved: true,
  monthlyReport: true,
  /** Managers: a copy of every new request of the company. */
  companyTickets: false,
};

export function emailPrefs(stored: Record<string, unknown> | null | undefined): Record<EmailPrefKey, boolean> {
  const out = { ...EMAIL_PREF_DEFAULTS };
  for (const k of EMAIL_PREF_KEYS) if (typeof stored?.[k] === 'boolean') out[k] = stored[k] as boolean;
  return out;
}

export const NOTIFY_MODES = ['main', 'other', 'both'] as const;

/** Where a contact receives e-mails: the main address, the second mailbox, or both. */
export function contactAddresses(c: { email: string | null; notifyEmail?: string | null; notifyMode?: string | null }): string[] {
  const main = c.email?.trim() || null;
  const other = c.notifyEmail?.trim() || null;
  const list = c.notifyMode === 'other' ? [other ?? main] : c.notifyMode === 'both' ? [main, other] : [main];
  return [...new Set(list.filter((x): x is string => !!x).map((x) => x.toLowerCase()))];
}

/* ----------------------------------------------------------------- helpers */

interface Ctx {
  db: Db;
  config: Config;
  smtp: SmtpSettings;
  transport: Transporter;
  settings: SystemSettings;
  t: MailT;
  base: string;
  brand: MailBrand;
}

async function context(db: Db, config: Config, transport?: Transporter): Promise<Ctx | null> {
  const smtp = await resolveSmtp(db, config);
  if (!smtp) return null;
  const settings = await getSystemSettings(db);
  const brand = await loadMailBrand(db, config, smtp, settings);
  return {
    db,
    config,
    smtp,
    transport: transport ?? transportFor(smtp),
    settings,
    t: mailTranslator(mailLang(settings.language)),
    base: brand.base,
    brand,
  };
}

/** Sends one branded e-mail through the configured mailbox. */
export async function sendBranded(
  db: Tx,
  config: Config,
  smtp: SmtpSettings,
  transport: Transporter,
  to: string | string[],
  subject: string,
  content: EmailContent,
  extra: { replyTo?: string; attachments?: object[]; cc?: string[]; bcc?: string[]; brand?: MailBrand } = {},
) {
  const brand = extra.brand ?? (await loadMailBrand(db, config, smtp));
  const { html, text } = renderEmail(brand, content);
  const attachments = [...(extra.attachments ?? []), ...logoAttachment(brand)];
  await transport.sendMail({
    from: smtp.from,
    to: Array.isArray(to) && to.length === 1 ? to[0] : to,
    ...(extra.cc?.length ? { cc: extra.cc } : {}),
    ...(extra.bcc?.length ? { bcc: extra.bcc } : {}),
    subject,
    text,
    html,
    ...(extra.replyTo || smtp.replyTo ? { replyTo: extra.replyTo || smtp.replyTo } : {}),
    ...(attachments.length ? { attachments } : {}),
  });
}

const send = (ctx: Ctx, to: string | string[], subject: string, content: EmailContent, extra: { replyTo?: string; attachments?: object[] } = {}) =>
  sendBranded(ctx.db, ctx.config, ctx.smtp, ctx.transport, to, subject, content, { ...extra, brand: ctx.brand });

function formatDate(ctx: Ctx, d: Date | string | null | undefined, withTime = true) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(mailLang(ctx.settings.language), {
      dateStyle: 'medium',
      ...(withTime ? { timeStyle: 'short' } : {}),
      timeZone: ctx.settings.timezone,
    }).format(new Date(d));
  } catch {
    return new Date(d).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function formatMinutes(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

const plain = (v: string | null | undefined) => noteImagesToText(v ?? '').trim();

async function sentBefore(db: Db, ticketId: number, kind: string, audience: string, marker?: string) {
  const [row] = await db
    .select({ id: s.ticketEvents.id })
    .from(s.ticketEvents)
    .where(
      and(
        eq(s.ticketEvents.ticketId, ticketId),
        eq(s.ticketEvents.type, 'email_sent'),
        sql`${s.ticketEvents.data}->>'kind' = ${kind}`,
        sql`${s.ticketEvents.data}->>'audience' = ${audience}`,
        marker ? sql`${s.ticketEvents.data}->>'marker' = ${marker}` : undefined,
      ),
    )
    .limit(1);
  return !!row;
}

const record = (db: Db, ticketId: number, kind: string, audience: string, to: string[], marker?: string) =>
  db.insert(s.ticketEvents).values({ ticketId, userId: null, type: 'email_sent', data: { kind, audience, to: to.join(', '), ...(marker ? { marker } : {}) } });

async function ticketInfo(db: Db, ticketId: number) {
  const [row] = await db
    .select({
      id: s.tickets.id,
      ticketNumber: s.tickets.ticketNumber,
      title: s.tickets.title,
      description: s.tickets.description,
      resolution: s.tickets.resolution,
      tags: s.tickets.tags,
      companyId: s.tickets.companyId,
      createdAt: s.tickets.createdAt,
      resolvedAt: s.tickets.resolvedAt,
      createdById: s.tickets.createdById,
      companyName: s.companies.name,
      contactId: s.contacts.id,
      contactFirstName: s.contacts.firstName,
      contactLastName: s.contacts.lastName,
      contactEmail: s.contacts.email,
      contactNotifyEmail: s.contacts.notifyEmail,
      contactNotifyMode: s.contacts.notifyMode,
      contactActive: s.contacts.isActive,
      contactPortal: s.contacts.portalEnabled,
      contactPrefs: s.contacts.emailPreferences,
      priorityName: s.ticketPriorities.name,
      statusName: s.ticketStatuses.name,
      statusColor: s.ticketStatuses.color,
      statusCategory: s.ticketStatuses.category,
      sourceName: s.ticketSources.name,
      deviceName: s.configurationItems.name,
      assignedName: sql<string | null>`(select nullif(trim(u.first_name || ' ' || u.last_name), '') from users u where u.id = ${s.tickets.assignedUserId})`,
      creatorName: sql<string | null>`(select nullif(trim(u.first_name || ' ' || u.last_name), '') from users u where u.id = ${s.tickets.createdById})`,
    })
    .from(s.tickets)
    .innerJoin(s.companies, eq(s.companies.id, s.tickets.companyId))
    .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
    .leftJoin(s.ticketPriorities, eq(s.ticketPriorities.id, s.tickets.priorityId))
    .leftJoin(s.ticketSources, eq(s.ticketSources.id, s.tickets.sourceId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.tickets.contactId))
    .leftJoin(s.configurationItems, eq(s.configurationItems.id, s.tickets.configurationItemId))
    .where(eq(s.tickets.id, ticketId));
  return row ?? null;
}
type TicketInfo = NonNullable<Awaited<ReturnType<typeof ticketInfo>>>;

const contactName = (t: TicketInfo) => [t.contactFirstName, t.contactLastName].filter(Boolean).join(' ');
const portalLink = (ctx: Ctx, path: string) => (ctx.base ? `${ctx.base}/portal${path}` : null);
const requesterAddresses = (tk: TicketInfo) =>
  tk.contactId && tk.contactActive ? contactAddresses({ email: tk.contactEmail, notifyEmail: tk.contactNotifyEmail, notifyMode: tk.contactNotifyMode }) : [];
const statusOf = (tk: TicketInfo) => ({ label: tk.statusName, color: tk.statusColor });

/** The IT addresses of Administration → Client portal. */
export function staffAddresses(settings: SystemSettings) {
  return parseAddresses(settings.staffAlertEmails).valid;
}

/* ------------------------------------------------------------- new ticket */

/** IT alert + client confirmation (+ copies for managers who asked for them) for a new ticket. */
export async function sendTicketCreatedEmails(db: Db, config: Config, ticketId: number, transport?: Transporter) {
  const ctx = await context(db, config, transport);
  const result = { staff: 0, client: 0 };
  if (!ctx) return result;
  const tk = await ticketInfo(db, ticketId);
  if (!tk) return result;
  const { t, settings } = ctx;
  const org = settings.organizationName;
  const ref = tk.ticketNumber;
  const description = plain(tk.description);
  const source = (tk.sourceName ?? '').toLowerCase();
  const openedBy =
    source === 'portal'
      ? `${t('viaPortal')}${tk.contactId ? ` (${contactName(tk)})` : ''}`
      : tk.creatorName
        ? t('viaTeam', { name: tk.creatorName })
        : source === 'email'
          ? t('viaEmail')
          : t('viaAuto');

  // 1. IT team alert.
  const staff = staffAddresses(settings);
  if (settings.staffAlertOnNewTicket && staff.length && !(await sentBefore(db, ticketId, 'created', 'staff'))) {
    await send(ctx, staff, t('staffSubject', { ref, company: tk.companyName, title: tk.title }), {
      preheader: `${tk.companyName} — ${tk.title}`,
      eyebrow: t('eyebrowNew'),
      heading: tk.title,
      paragraphs: [t('staffP1')],
      card: {
        ref,
        status: statusOf(tk),
        facts: [
          [t('company'), tk.companyName],
          ...(tk.contactId ? ([[t('requestedBy'), `${contactName(tk)}${tk.contactEmail ? ` <${tk.contactEmail}>` : ''}`]] as [string, string][]) : []),
          [t('priority'), tk.priorityName ?? '—'],
          [t('openedBy'), openedBy],
          ...(tk.deviceName ? ([[t('device'), tk.deviceName]] as [string, string][]) : []),
          [t('openedOn'), formatDate(ctx, tk.createdAt)],
        ],
      },
      quote: description ? { label: t('description'), text: description } : undefined,
      button: ctx.base ? { label: t('openTicket'), url: `${ctx.base}/tickets/${tk.id}` } : null,
      footer: t('footerStaff'),
    });
    await record(db, ticketId, 'created', 'staff', staff);
    result.staff = staff.length;
  }

  // Recurring maintenance tickets are not announced to clients.
  if (!settings.clientEmailsEnabled || tk.tags?.includes('recurring')) return result;

  const card = {
    ref,
    title: tk.title,
    status: statusOf(tk),
    facts: [
      [t('ref'), ref],
      [t('priority'), tk.priorityName ?? '—'],
      [t('openedOn'), formatDate(ctx, tk.createdAt)],
      ...(tk.deviceName ? ([[t('device'), tk.deviceName]] as [string, string][]) : []),
    ] as [string, string][],
  };
  const team = { sender: t('team', { org }) };

  // 2. Confirmation to the requester.
  const to = requesterAddresses(tk);
  if (to.length && emailPrefs(tk.contactPrefs).ticketCreated && !(await sentBefore(db, ticketId, 'created', 'client'))) {
    await send(ctx, to, t('createdSubject', { ref, title: tk.title }), {
      preheader: t('createdP1', { org, ref }),
      eyebrow: t('eyebrowCreated'),
      heading: t('createdHeading'),
      greeting: t('hello', { name: tk.contactFirstName ?? '' }),
      paragraphs: [t('createdP1', { org, ref }), tk.contactPortal ? t('createdP2') : ''].filter(Boolean),
      card,
      quote: description ? { label: t('description'), text: description } : undefined,
      button: tk.contactPortal && portalLink(ctx, `/tickets/${tk.id}`) ? { label: t('follow'), url: portalLink(ctx, `/tickets/${tk.id}`)! } : null,
      hint: t('replyHint', { ref }),
      footer: t('footerClient', { org }),
      signature: team,
    });
    await record(db, ticketId, 'created', 'client', to);
    result.client++;
  }

  // 3. Copies for company managers who asked for every new request.
  const managers = await db
    .select({ id: s.contacts.id, email: s.contacts.email, notifyEmail: s.contacts.notifyEmail, notifyMode: s.contacts.notifyMode, firstName: s.contacts.firstName, prefs: s.contacts.emailPreferences })
    .from(s.contacts)
    .where(
      and(
        eq(s.contacts.companyId, tk.companyId),
        eq(s.contacts.isActive, true),
        eq(s.contacts.portalEnabled, true),
        or(eq(s.contacts.isPrimary, true), eq(s.contacts.portalRole, 'manager')),
      ),
    );
  for (const m of managers) {
    const addrs = contactAddresses(m);
    if (m.id === tk.contactId || !addrs.length || !emailPrefs(m.prefs).companyTickets) continue;
    const audience = `manager:${m.id}`;
    if (await sentBefore(db, ticketId, 'created', audience)) continue;
    await send(ctx, addrs, t('staffSubject', { ref, company: tk.companyName, title: tk.title }), {
      preheader: tk.title,
      eyebrow: t('eyebrowNew'),
      heading: t('copyHeading', { company: tk.companyName }),
      greeting: t('hello', { name: m.firstName }),
      paragraphs: [t('copyP1', { contact: tk.contactId ? contactName(tk) : t('viaTeam', { name: org }), org })],
      card,
      quote: description ? { label: t('description'), text: description } : undefined,
      button: portalLink(ctx, `/tickets/${tk.id}`) ? { label: t('viewRequest'), url: portalLink(ctx, `/tickets/${tk.id}`)! } : null,
      footer: t('footerClient', { org }),
      signature: team,
    });
    await record(db, ticketId, 'created', audience, addrs);
    result.client++;
  }
  return result;
}

/* --------------------------------------------------------------- resolved */

/** Tells the requester their ticket is resolved (once per resolution). */
export async function sendTicketResolvedEmail(db: Db, config: Config, ticketId: number, transport?: Transporter) {
  const ctx = await context(db, config, transport);
  if (!ctx || !ctx.settings.clientEmailsEnabled) return { sent: false };
  const tk = await ticketInfo(db, ticketId);
  if (!tk || !tk.resolvedAt || !['resolved', 'closed'].includes(tk.statusCategory)) return { sent: false };
  const to = requesterAddresses(tk);
  if (!to.length || !emailPrefs(tk.contactPrefs).ticketResolved || tk.tags?.includes('recurring')) return { sent: false };
  const marker = tk.resolvedAt.toISOString();
  if (await sentBefore(db, ticketId, 'resolved', 'client', marker)) return { sent: false };
  const { t, settings } = ctx;
  const org = settings.organizationName;
  let minutes = 0;
  if (settings.portalShowTime) {
    const [m] = await db
      .select({ n: sql<number>`coalesce(sum(${s.timeEntries.durationMinutes}), 0)::int` })
      .from(s.timeEntries)
      .where(and(eq(s.timeEntries.ticketId, ticketId), inArray(s.timeEntries.status, ['submitted', 'approved', 'billed'])));
    minutes = m?.n ?? 0;
  }
  const resolution = plain(tk.resolution);
  await send(ctx, to, t('resolvedSubject', { ref: tk.ticketNumber, title: tk.title }), {
    preheader: t('resolvedP1', { ref: tk.ticketNumber }),
    eyebrow: t('eyebrowResolved'),
    heading: t('resolvedHeading'),
    greeting: t('hello', { name: tk.contactFirstName ?? '' }),
    paragraphs: [t('resolvedP1', { ref: tk.ticketNumber })],
    card: {
      ref: tk.ticketNumber,
      title: tk.title,
      status: statusOf(tk),
      facts: [
        [t('openedOn'), formatDate(ctx, tk.createdAt)],
        [t('resolvedOn'), formatDate(ctx, tk.resolvedAt)],
        ...(minutes ? ([[t('timeSpent'), formatMinutes(minutes)]] as [string, string][]) : []),
      ],
    },
    quote: resolution ? { label: t('solution'), text: resolution } : undefined,
    button: tk.contactPortal && portalLink(ctx, `/tickets/${tk.id}`) ? { label: t('viewRequest'), url: portalLink(ctx, `/tickets/${tk.id}`)! } : null,
    hint: t('resolvedP2'),
    footer: t('footerClient', { org }),
    accent: '#16a34a',
    signature: { sender: tk.assignedName ?? t('team', { org }) },
  });
  await record(db, ticketId, 'resolved', 'client', to, marker);
  return { sent: true };
}

/* ---------------------------------------------------------- reply e-mails */

/**
 * A customer-visible note e-mailed to the ticket contact (the technician
 * ticked "E-mail the contact"). Skipped when the contact turned replies off.
 */
export async function sendReplyEmail(db: Db, config: Config, noteId: number, attachments: object[], text: string, transport?: Transporter) {
  const ctx = await context(db, config, transport);
  if (!ctx) throw new Error('SMTP is not configured');
  const [note] = await db
    .select({ ticketId: s.ticketNotes.ticketId, author: sql<string | null>`(select nullif(trim(u.first_name || ' ' || u.last_name), '') from users u where u.id = ${s.ticketNotes.userId})` })
    .from(s.ticketNotes)
    .where(eq(s.ticketNotes.id, noteId));
  if (!note) return { sent: false as const, reason: 'missing' };
  const tk = await ticketInfo(db, note.ticketId);
  const to = tk ? requesterAddresses(tk) : [];
  if (!tk || !to.length) return { sent: false as const, reason: 'no_email' };
  if (!emailPrefs(tk.contactPrefs).ticketReplies) return { sent: false as const, reason: 'opted_out', to: to.join(', '), ticketId: tk.id };
  const { t, settings } = ctx;
  const org = settings.organizationName;
  const author = note.author ?? t('team', { org });
  const content: EmailContent = {
    preheader: text.slice(0, 120),
    eyebrow: t('eyebrowReply'),
    heading: t('replyHeading'),
    greeting: t('hello', { name: tk.contactFirstName ?? '' }),
    paragraphs: [],
    quote: { label: t('replyFrom', { author }), text },
    card: { ref: tk.ticketNumber, title: tk.title, status: statusOf(tk), facts: [[t('ref'), tk.ticketNumber]] },
    button: tk.contactPortal && portalLink(ctx, `/tickets/${tk.id}`) ? { label: t('viewRequest'), url: portalLink(ctx, `/tickets/${tk.id}`)! } : null,
    hint: t('replyHint', { ref: tk.ticketNumber }),
    footer: t('footerClient', { org }),
    signature: { sender: author },
  };
  // Keep "[TKA-…] title" so the inbound poller threads the client's answer.
  await send(ctx, to, `[${tk.ticketNumber}] ${tk.title}`, content, { attachments });
  return { sent: true as const, to: to.join(', '), ticketId: tk.id };
}

/** Alerts the IT addresses when a client answers in the portal. */
export async function sendClientReplyAlert(db: Db, config: Config, noteId: number, transport?: Transporter) {
  const ctx = await context(db, config, transport);
  if (!ctx || !ctx.settings.staffAlertOnClientReply) return { sent: 0 };
  const staff = staffAddresses(ctx.settings);
  if (!staff.length) return { sent: 0 };
  const [note] = await db.select().from(s.ticketNotes).where(eq(s.ticketNotes.id, noteId));
  if (!note) return { sent: 0 };
  const tk = await ticketInfo(db, note.ticketId);
  if (!tk) return { sent: 0 };
  const marker = String(noteId);
  if (await sentBefore(db, tk.id, 'client_reply', 'staff', marker)) return { sent: 0 };
  const { t } = ctx;
  const name = contactName(tk) || tk.companyName;
  await send(
    ctx,
    staff,
    t('clientReplySubject', { ref: tk.ticketNumber, name, title: tk.title }),
    {
      preheader: plain(note.body).slice(0, 120),
      eyebrow: t('eyebrowClientReply'),
      heading: t('clientReplyHeading'),
      paragraphs: [],
      quote: { label: t('message'), text: plain(note.body).replace(/^.*? wrote:\s*/s, '') },
      card: {
        ref: tk.ticketNumber,
        title: tk.title,
        status: statusOf(tk),
        facts: [
          [t('company'), tk.companyName],
          [t('requestedBy'), name],
        ],
      },
      button: ctx.base ? { label: t('openTicket'), url: `${ctx.base}/tickets/${tk.id}` } : null,
      footer: t('footerStaff'),
    },
    tk.contactEmail ? { replyTo: tk.contactEmail } : {},
  );
  await record(db, tk.id, 'client_reply', 'staff', staff, marker);
  return { sent: staff.length };
}

/* ---------------------------------------------------------- monthly report */

export function monthLabel(period: string, language: string) {
  const [y, m] = period.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(mailLang(language), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, 1)));
  } catch {
    return period;
  }
}

/** E-mails the company's portal managers that a monthly report was published. */
export async function sendReportPublishedEmails(db: Db, config: Config, reportId: number, transport?: Transporter) {
  const ctx = await context(db, config, transport);
  if (!ctx || !ctx.settings.clientEmailsEnabled) return { sent: 0 };
  const [report] = await db.select().from(s.clientReports).where(eq(s.clientReports.id, reportId));
  if (!report || report.status !== 'published' || report.emailedAt) return { sent: 0 };
  const recipients = await db
    .select({ email: s.contacts.email, notifyEmail: s.contacts.notifyEmail, notifyMode: s.contacts.notifyMode, firstName: s.contacts.firstName, prefs: s.contacts.emailPreferences })
    .from(s.contacts)
    .where(
      and(
        eq(s.contacts.companyId, report.companyId),
        eq(s.contacts.isActive, true),
        eq(s.contacts.portalEnabled, true),
        or(eq(s.contacts.isPrimary, true), eq(s.contacts.portalRole, 'manager')),
      ),
    );
  const { t, settings } = ctx;
  const org = settings.organizationName;
  const month = monthLabel(report.period, settings.language);
  const d = report.data as {
    tickets?: { opened?: number; resolved?: number };
    work?: { minutes?: number };
    health?: { score?: number | null };
    security?: { patchedPct?: number | null } | null;
  };
  const hidden = new Set(report.hiddenSections);
  const stats: [string, string][] = [];
  if (!hidden.has('tickets')) stats.push([t('ticketsOpened'), String(d.tickets?.opened ?? 0)], [t('ticketsResolved'), String(d.tickets?.resolved ?? 0)]);
  if (!hidden.has('work') && settings.portalShowTime) stats.push([t('timeSpent'), formatMinutes(d.work?.minutes ?? 0)]);
  if (d.health?.score != null) stats.push([t('health'), `${d.health.score}/100`]);
  if (!hidden.has('security') && d.security?.patchedPct != null) stats.push([t('patched'), `${d.security.patchedPct}%`]);
  let sent = 0;
  for (const r of recipients) {
    const to = contactAddresses(r);
    if (!to.length || !emailPrefs(r.prefs).monthlyReport) continue;
    await send(ctx, to, t('reportSubject', { month }), {
      preheader: t('reportP1', { month }),
      eyebrow: t('eyebrowReport'),
      heading: `${t('reportHeading')} — ${month}`,
      greeting: t('hello', { name: r.firstName }),
      paragraphs: [t('reportP1', { month })],
      stats: stats.slice(0, 4),
      button: portalLink(ctx, `/reports/${report.id}`) ? { label: t('readReport'), url: portalLink(ctx, `/reports/${report.id}`)! } : null,
      footer: t('footerClient', { org }),
      signature: { sender: t('team', { org }) },
    });
    sent++;
  }
  await db.update(s.clientReports).set({ emailedAt: new Date() }).where(eq(s.clientReports.id, report.id));
  return { sent };
}

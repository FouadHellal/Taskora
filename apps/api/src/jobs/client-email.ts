/**
 * Proactive e-mails: alerts to the IT team about new tickets and client
 * replies, and HTML e-mails to clients (request received, reply, resolved,
 * monthly report). Clients choose what they receive in the portal (My
 * account); Administration → Client portal sets the IT addresses and the
 * master switches. Every send is recorded as a ticket event so a retried job
 * never mails the same person twice.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import { noteImagesToText } from '@taskora/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import * as s from '../db/schema/index.js';
import { getSystemSettings, type SystemSettings } from '../lib/settings.js';
import { parseAddresses, resolveSmtp, transportFor, type SmtpSettings } from '../lib/mail.js';
import { mailLang, mailTranslator, type MailT } from './mail-i18n.js';

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

/* --------------------------------------------------------------- template */

export function escapeHtml(v: string) {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const paragraphHtml = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

export interface EmailContent {
  /** Hidden preview line shown by mail clients. */
  preheader: string;
  heading: string;
  greeting?: string;
  paragraphs: string[];
  facts?: [string, string][];
  quote?: { label: string; text: string };
  /** Large numbers (label, value) shown as tiles, e.g. in the monthly report e-mail. */
  stats?: [string, string][];
  button?: { label: string; url: string } | null;
  hint?: string;
  footer: string;
  accent?: string;
}

/** Table-based HTML that renders consistently in Outlook, Gmail and phones. */
export function renderEmail(orgName: string, c: EmailContent, logoCid?: string | null): { html: string; text: string } {
  const accent = c.accent ?? '#2563eb';
  const head = logoCid
    ? `<img src="cid:${logoCid}" alt="${escapeHtml(orgName)}" height="40" style="display:block;max-height:40px;border:0">`
    : `<span style="font-size:20px;font-weight:700;color:#0f172a">${escapeHtml(orgName)}</span>`;
  const facts = c.facts?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate">${c.facts
        .map(
          ([k, v], i) =>
            `<tr><td style="padding:10px 14px;font-size:13px;color:#64748b;width:38%;${i ? 'border-top:1px solid #e2e8f0;' : ''}">${escapeHtml(k)}</td><td style="padding:10px 14px;font-size:14px;color:#0f172a;font-weight:600;${i ? 'border-top:1px solid #e2e8f0;' : ''}">${escapeHtml(v)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const stats = c.stats?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="margin:16px 0"><tr>${c.stats
        .map(
          ([k, v]) =>
            `<td style="background:#f1f5f9;border-radius:8px;padding:14px 10px;text-align:center"><div style="font-size:22px;font-weight:700;color:${accent}">${escapeHtml(v)}</div><div style="font-size:12px;color:#64748b;margin-top:4px">${escapeHtml(k)}</div></td>`,
        )
        .join('')}</tr></table>`
    : '';
  const quote = c.quote?.text.trim()
    ? `<div style="margin:20px 0"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#64748b;margin-bottom:6px">${escapeHtml(c.quote.label)}</div><div style="border-left:3px solid ${accent};background:#f8fafc;padding:12px 16px;font-size:14px;line-height:1.55;color:#334155">${paragraphHtml(c.quote.text.trim().slice(0, 4000))}</div></div>`
    : '';
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td style="background:${accent};border-radius:6px"><a href="${escapeHtml(c.button.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(c.button.label)}</a></td></tr></table>`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="padding:20px 28px;border-bottom:4px solid ${accent}">${head}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a">${escapeHtml(c.heading)}</h1>
${c.greeting ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#334155">${escapeHtml(c.greeting)}</p>` : ''}
${c.paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#334155">${paragraphHtml(p)}</p>`).join('')}
${stats}${facts}${quote}${button}
${c.hint ? `<p style="margin:0 0 4px;font-size:13px;line-height:1.5;color:#64748b">${paragraphHtml(c.hint)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#94a3b8">${paragraphHtml(c.footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    c.heading,
    '',
    c.greeting ?? '',
    ...c.paragraphs,
    ...(c.stats ?? []).map(([k, v]) => `${k}: ${v}`),
    ...(c.facts ?? []).map(([k, v]) => `${k}: ${v}`),
    c.quote?.text.trim() ? `\n${c.quote.label}:\n${c.quote.text.trim()}` : '',
    c.button ? `\n${c.button.label}: ${c.button.url}` : '',
    c.hint ? `\n${c.hint}` : '',
    '\n--',
    c.footer,
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  return { html, text };
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
  logo: { cid: string; content: Buffer; contentType: string } | null;
}

async function context(db: Db, config: Config, transport?: Transporter): Promise<Ctx | null> {
  const smtp = await resolveSmtp(db, config);
  if (!smtp) return null;
  const settings = await getSystemSettings(db);
  const [logo] = await db.select().from(s.logos).where(and(eq(s.logos.entityType, 'organization'), eq(s.logos.entityId, 0)));
  return {
    db,
    config,
    smtp,
    transport: transport ?? transportFor(smtp),
    settings,
    t: mailTranslator(mailLang(settings.language)),
    base: (config.PUBLIC_URL ?? '').replace(/\/$/, ''),
    logo: logo ? { cid: 'org-logo@taskora', content: Buffer.from(logo.data, 'base64'), contentType: logo.mimeType } : null,
  };
}

async function send(ctx: Ctx, to: string | string[], subject: string, content: EmailContent, extra: { replyTo?: string; attachments?: object[] } = {}) {
  const { html, text } = renderEmail(ctx.settings.organizationName, content, ctx.logo?.cid);
  const attachments = [...(extra.attachments ?? []), ...(ctx.logo ? [{ filename: 'logo', content: ctx.logo.content, contentType: ctx.logo.contentType, cid: ctx.logo.cid }] : [])];
  await ctx.transport.sendMail({
    from: ctx.smtp.from,
    to,
    subject,
    text,
    html,
    ...(extra.replyTo || ctx.smtp.replyTo ? { replyTo: extra.replyTo || ctx.smtp.replyTo } : {}),
    ...(attachments.length ? { attachments } : {}),
  });
}

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
      contactActive: s.contacts.isActive,
      contactPortal: s.contacts.portalEnabled,
      contactPrefs: s.contacts.emailPreferences,
      priorityName: s.ticketPriorities.name,
      statusName: s.ticketStatuses.name,
      statusCategory: s.ticketStatuses.category,
      sourceName: s.ticketSources.name,
      deviceName: s.configurationItems.name,
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
      heading: `${t('staffHeading')} ${ref}`,
      paragraphs: [t('staffP1')],
      facts: [
        [t('ref'), ref],
        [t('subject'), tk.title],
        [t('company'), tk.companyName],
        ...(tk.contactId ? ([[t('requestedBy'), `${contactName(tk)}${tk.contactEmail ? ` <${tk.contactEmail}>` : ''}`]] as [string, string][]) : []),
        [t('priority'), tk.priorityName ?? '—'],
        [t('openedBy'), openedBy],
        ...(tk.deviceName ? ([[t('device'), tk.deviceName]] as [string, string][]) : []),
        [t('openedOn'), formatDate(ctx, tk.createdAt)],
      ],
      quote: description ? { label: t('description'), text: description } : undefined,
      button: ctx.base ? { label: t('openTicket'), url: `${ctx.base}/tickets/${tk.id}` } : null,
      footer: t('footerStaff'),
    });
    await record(db, ticketId, 'created', 'staff', staff);
    result.staff = staff.length;
  }

  // Recurring maintenance tickets are not announced to clients.
  if (!settings.clientEmailsEnabled || tk.tags?.includes('recurring')) return result;

  // 2. Confirmation to the requester.
  const facts: [string, string][] = [
    [t('ref'), ref],
    [t('subject'), tk.title],
    [t('priority'), tk.priorityName ?? '—'],
    [t('status'), tk.statusName],
    [t('openedOn'), formatDate(ctx, tk.createdAt)],
    ...(tk.deviceName ? ([[t('device'), tk.deviceName]] as [string, string][]) : []),
  ];
  if (tk.contactId && tk.contactEmail && tk.contactActive && emailPrefs(tk.contactPrefs).ticketCreated && !(await sentBefore(db, ticketId, 'created', 'client'))) {
    await send(ctx, tk.contactEmail, t('createdSubject', { ref, title: tk.title }), {
      preheader: t('createdP1', { org, ref }),
      heading: t('createdHeading'),
      greeting: t('hello', { name: tk.contactFirstName ?? '' }),
      paragraphs: [t('createdP1', { org, ref }), tk.contactPortal ? t('createdP2') : ''].filter(Boolean),
      facts,
      quote: description ? { label: t('description'), text: description } : undefined,
      button: tk.contactPortal && portalLink(ctx, `/tickets/${tk.id}`) ? { label: t('follow'), url: portalLink(ctx, `/tickets/${tk.id}`)! } : null,
      hint: t('replyHint', { ref }),
      footer: t('footerClient', { org }),
    });
    await record(db, ticketId, 'created', 'client', [tk.contactEmail]);
    result.client++;
  }

  // 3. Copies for company managers who asked for every new request.
  const managers = await db
    .select({ id: s.contacts.id, email: s.contacts.email, firstName: s.contacts.firstName, prefs: s.contacts.emailPreferences })
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
    if (m.id === tk.contactId || !m.email || !emailPrefs(m.prefs).companyTickets) continue;
    const audience = `manager:${m.id}`;
    if (await sentBefore(db, ticketId, 'created', audience)) continue;
    await send(ctx, m.email, t('staffSubject', { ref, company: tk.companyName, title: tk.title }), {
      preheader: tk.title,
      heading: t('copyHeading', { company: tk.companyName }),
      greeting: t('hello', { name: m.firstName }),
      paragraphs: [t('copyP1', { contact: tk.contactId ? contactName(tk) : t('viaTeam', { name: org }), org })],
      facts,
      quote: description ? { label: t('description'), text: description } : undefined,
      button: portalLink(ctx, `/tickets/${tk.id}`) ? { label: t('viewRequest'), url: portalLink(ctx, `/tickets/${tk.id}`)! } : null,
      footer: t('footerClient', { org }),
    });
    await record(db, ticketId, 'created', audience, [m.email]);
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
  if (!tk.contactId || !tk.contactEmail || !tk.contactActive || !emailPrefs(tk.contactPrefs).ticketResolved || tk.tags?.includes('recurring')) return { sent: false };
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
  await send(ctx, tk.contactEmail, t('resolvedSubject', { ref: tk.ticketNumber, title: tk.title }), {
    preheader: t('resolvedP1', { ref: tk.ticketNumber }),
    heading: t('resolvedHeading'),
    greeting: t('hello', { name: tk.contactFirstName ?? '' }),
    paragraphs: [t('resolvedP1', { ref: tk.ticketNumber }), t('resolvedP2')],
    facts: [
      [t('ref'), tk.ticketNumber],
      [t('subject'), tk.title],
      [t('openedOn'), formatDate(ctx, tk.createdAt)],
      [t('resolvedOn'), formatDate(ctx, tk.resolvedAt)],
      ...(minutes ? ([[t('timeSpent'), formatMinutes(minutes)]] as [string, string][]) : []),
    ],
    quote: resolution ? { label: t('solution'), text: resolution } : undefined,
    button: tk.contactPortal && portalLink(ctx, `/tickets/${tk.id}`) ? { label: t('viewRequest'), url: portalLink(ctx, `/tickets/${tk.id}`)! } : null,
    footer: t('footerClient', { org }),
    accent: '#16a34a',
  });
  await record(db, ticketId, 'resolved', 'client', [tk.contactEmail], marker);
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
  if (!tk?.contactEmail) return { sent: false as const, reason: 'no_email' };
  if (!emailPrefs(tk.contactPrefs).ticketReplies) return { sent: false as const, reason: 'opted_out', to: tk.contactEmail, ticketId: tk.id };
  const { t, settings } = ctx;
  const org = settings.organizationName;
  const author = note.author ?? org;
  const content: EmailContent = {
    preheader: text.slice(0, 120),
    heading: t('replyHeading'),
    greeting: t('hello', { name: tk.contactFirstName ?? '' }),
    paragraphs: [],
    quote: { label: t('replyFrom', { author }), text },
    facts: [
      [t('ref'), tk.ticketNumber],
      [t('subject'), tk.title],
      [t('status'), tk.statusName],
    ],
    button: tk.contactPortal && portalLink(ctx, `/tickets/${tk.id}`) ? { label: t('viewRequest'), url: portalLink(ctx, `/tickets/${tk.id}`)! } : null,
    hint: t('replyHint', { ref: tk.ticketNumber }),
    footer: t('footerClient', { org }),
  };
  // Keep "[TKA-…] title" so the inbound poller threads the client's answer.
  await send(ctx, tk.contactEmail, `[${tk.ticketNumber}] ${tk.title}`, content, { attachments });
  return { sent: true as const, to: tk.contactEmail, ticketId: tk.id };
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
      heading: `${t('clientReplyHeading')} — ${tk.ticketNumber}`,
      paragraphs: [],
      facts: [
        [t('subject'), tk.title],
        [t('company'), tk.companyName],
        [t('requestedBy'), name],
        [t('status'), tk.statusName],
      ],
      quote: { label: t('message'), text: plain(note.body).replace(/^.*? wrote:\s*/s, '') },
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
    .select({ email: s.contacts.email, firstName: s.contacts.firstName, prefs: s.contacts.emailPreferences })
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
    if (!r.email || !emailPrefs(r.prefs).monthlyReport) continue;
    await send(ctx, r.email, t('reportSubject', { month }), {
      preheader: t('reportP1', { month }),
      heading: `${t('reportHeading')} — ${month}`,
      greeting: t('hello', { name: r.firstName }),
      paragraphs: [t('reportP1', { month })],
      stats: stats.slice(0, 4),
      button: portalLink(ctx, `/reports/${report.id}`) ? { label: t('readReport'), url: portalLink(ctx, `/reports/${report.id}`)! } : null,
      footer: t('footerClient', { org }),
    });
    sent++;
  }
  await db.update(s.clientReports).set({ emailedAt: new Date() }).where(eq(s.clientReports.id, report.id));
  return { sent };
}

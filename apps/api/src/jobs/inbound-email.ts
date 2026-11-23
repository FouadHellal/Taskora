/**
 * Inbound e-mail → ticket. New messages become tickets (company resolved from
 * the sender's contact record or e-mail domain); replies whose subject
 * carries a ticket number such as [TKA-000142] are appended to that ticket as
 * customer-visible notes and reopen it when it was waiting or resolved.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import * as s from '../db/schema/index.js';
import { PUBLIC_MAIL_DOMAINS } from '@taskora/shared';
import { getSystemSettings } from '../lib/settings.js';
import { resolveImap } from '../lib/imap-settings.js';
import { addTicketNote, createTicket, getTicketRow, updateTicket } from '../modules/tickets/service.js';
import { runTicketRules } from '../modules/automation/engine.js';

export interface InboundMessage {
  messageId: string;
  fromAddress: string;
  fromName?: string | null;
  subject?: string | null;
  text?: string | null;
  attachments?: { fileName: string; contentType: string; content: Buffer }[];
}

const BLOCKED_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.js', '.jar', '.dll', '.sh', '.hta', '.html', '.htm', '.svg']);

export function imapConfigured(config: Config) {
  return !!(config.IMAP_HOST && config.IMAP_USER && config.IMAP_PASSWORD);
}

/** Removes quoted history from replies (common client markers). */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const markers = [/^On .+ wrote:$/i, /^Le .+ a écrit\s?:$/i, /^Op .+ schreef .+:$/i, /^-{2,}\s*Original Message\s*-{2,}/i, /^From: .+/i, /^De : .+/i, /^Van: .+/i, /^_{10,}$/];
  const cut = lines.findIndex((l) => markers.some((m) => m.test(l.trim())));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !l.startsWith('>'));
  return kept.join('\n').trim();
}

async function storeAttachments(db: Tx, config: Config, ticketId: number, files: InboundMessage['attachments'] = []) {
  const root = resolve(config.UPLOAD_DIR);
  let stored = 0;
  for (const f of files) {
    const name = (f.fileName || 'attachment').replace(/[\\/\0]/g, '_').slice(0, 200);
    const ext = extname(name).toLowerCase();
    if (BLOCKED_EXT.has(ext) || f.content.length > config.MAX_UPLOAD_MB * 1024 * 1024) continue;
    const key = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}${ext}`;
    await mkdir(join(root, key.split('/')[0]!), { recursive: true });
    await writeFile(join(root, key), f.content, { flag: 'wx' });
    await db.insert(s.attachments).values({
      entityType: 'ticket',
      entityId: ticketId,
      fileName: name,
      mimeType: f.contentType || 'application/octet-stream',
      sizeBytes: f.content.length,
      storageKey: key,
      sha256: createHash('sha256').update(f.content).digest('hex'),
      uploadedById: null,
    });
    stored++;
  }
  return stored;
}

export interface SenderMatch {
  companyId: number;
  contactId: number | null;
  /** How the company was found. */
  via: 'contact' | 'domain' | 'company_address';
  /** A contact was created for this sender. */
  createdContact?: string;
}

/** "Jean Dupont" / "jean.dupont@x.com" → first and last name for a new contact. */
export function nameFromSender(address: string, fromName?: string | null) {
  const clean = (fromName ?? '').replace(/["<>]/g, '').replace(/\s+/g, ' ').trim();
  if (clean && !clean.includes('@')) {
    const parts = clean.split(' ');
    return parts.length > 1 ? { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1)! } : { firstName: parts[0]!, lastName: '-' };
  }
  const local = address.split('@')[0] ?? address;
  const words = local.split(/[._-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return words.length > 1 ? { firstName: words.slice(0, -1).join(' '), lastName: words.at(-1)! } : { firstName: words[0] ?? local, lastName: '-' };
}

/** Companies that own a domain: listed in their e-mail domains, else (only for non-public domains) their e-mail address or website. */
async function companiesForDomain(db: Tx, domain: string) {
  const listed = await db
    .select({ id: s.companies.id })
    .from(s.companies)
    .where(and(eq(s.companies.isActive, true), sql`${domain} = any(${s.companies.emailDomains})`));
  if (listed.length || PUBLIC_MAIL_DOMAINS.has(domain)) return { ids: listed.map((c) => c.id), via: 'domain' as const };
  const guessed = await db
    .select({ id: s.companies.id })
    .from(s.companies)
    .where(and(eq(s.companies.isActive, true), or(ilike(s.companies.email, `%@${domain}`), sql`lower(${s.companies.website}) ~ ${`(^|[/.@])${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`}`)));
  return { ids: guessed.map((c) => c.id), via: 'company_address' as const };
}

/**
 * Identifies the sender: an active contact with that address (its company), otherwise the
 * one company that owns the address's domain. With `createContact`, a sender from a known
 * domain who is not a contact yet becomes one.
 */
export async function resolveSender(db: Tx, address: string, opts: { fromName?: string | null; createContact?: boolean; companyId?: number } = {}): Promise<SenderMatch | null> {
  const email = address.trim().toLowerCase();
  const domain = email.split('@')[1] ?? '';
  const contacts = await db
    .select({ id: s.contacts.id, companyId: s.contacts.companyId })
    .from(s.contacts)
    .innerJoin(s.companies, eq(s.companies.id, s.contacts.companyId))
    .where(and(or(sql`lower(${s.contacts.email}) = ${email}`, sql`lower(${s.contacts.notifyEmail}) = ${email}`), eq(s.contacts.isActive, true), eq(s.companies.isActive, true)));
  const inCompany = opts.companyId ? contacts.filter((c) => c.companyId === opts.companyId) : contacts;
  if (inCompany.length === 1) return { companyId: inCompany[0]!.companyId, contactId: inCompany[0]!.id, via: 'contact' };
  if (!domain) return null;
  const owners = await companiesForDomain(db, domain);
  // Several contacts share the address: keep the one in the company owning the domain.
  if (contacts.length > 1) {
    const match = contacts.filter((c) => owners.ids.includes(c.companyId));
    if (match.length === 1) return { companyId: match[0]!.companyId, contactId: match[0]!.id, via: 'contact' };
  }
  const ids = opts.companyId ? owners.ids.filter((id) => id === opts.companyId) : owners.ids;
  // Only an unambiguous domain match is trusted.
  if (ids.length !== 1) return null;
  const companyId = ids[0]!;
  if (!opts.createContact) return { companyId, contactId: null, via: owners.via };
  const name = nameFromSender(email, opts.fromName);
  const [created] = await db
    .insert(s.contacts)
    .values({ companyId, firstName: name.firstName.slice(0, 100), lastName: name.lastName.slice(0, 100), email, notes: 'Created automatically from an incoming e-mail.' })
    .returning({ id: s.contacts.id });
  return { companyId, contactId: created!.id, via: owners.via, createdContact: `${name.firstName} ${name.lastName}`.replace(/ -$/, '') };
}

export async function processInboundEmail(db: Db, config: Config, msg: InboundMessage): Promise<{ status: string; ticketId: number | null; detail?: string }> {
  const [seen] = await db.select({ id: s.inboundEmails.id }).from(s.inboundEmails).where(eq(s.inboundEmails.messageId, msg.messageId));
  if (seen) return { status: 'duplicate', ticketId: null };
  const settings = await getSystemSettings(db);
  const subject = (msg.subject ?? '').trim() || '(no subject)';
  const body = stripQuotedReply(msg.text ?? '');
  const log = (status: string, ticketId: number | null, detail?: string, handle: Tx = db) =>
    handle.insert(s.inboundEmails).values({ messageId: msg.messageId, fromAddress: msg.fromAddress, fromName: msg.fromName ?? null, subject, status, ticketId, detail: detail ?? null });

  // Reply to an existing ticket?
  const prefix = settings.ticketPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ref = subject.match(new RegExp(`\\[?(${prefix}\\d{4,})\\]?`, 'i'));
  if (ref) {
    const [ticket] = await db.select().from(s.tickets).where(sql`upper(${s.tickets.ticketNumber}) = ${ref[1]!.toUpperCase()}`);
    if (ticket) {
      // Who answered: a technician (by their user e-mail), a contact of the ticket's company
      // (created from the company's domain when needed) or someone else.
      const email = msg.fromAddress.trim().toLowerCase();
      const [staff] = await db.select({ id: s.users.id }).from(s.users).where(and(sql`lower(${s.users.email}) = ${email}`, eq(s.users.isActive, true)));
      let detail: string | undefined;
      const sender = staff
        ? null
        : ((await resolveSender(db, email, { fromName: msg.fromName, companyId: ticket.companyId, createContact: settings.inboundCreateContacts })) ??
          (await resolveSender(db, email, { fromName: msg.fromName })));
      if (sender?.createdContact) detail = `New contact created: ${sender.createdContact}`;
      const known = !!staff || !!sender?.contactId;
      await db.transaction(async (tx) => {
        await addTicketNote({ db: tx, userId: staff?.id ?? null }, ticket.id, {
          body: known ? body || '(empty message)' : `E-mail from ${msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}:\n\n${body || '(empty message)'}`,
          visibility: 'public',
          kind: 'email',
          contactId: staff ? null : (sender?.contactId ?? null),
        });
        const [status] = await tx.select().from(s.ticketStatuses).where(eq(s.ticketStatuses.id, ticket.statusId));
        if (!staff && status && ['waiting', 'resolved', 'closed'].includes(status.category)) {
          const [open] = await tx
            .select({ id: s.ticketStatuses.id })
            .from(s.ticketStatuses)
            .where(and(eq(s.ticketStatuses.category, 'open'), eq(s.ticketStatuses.isActive, true)))
            .orderBy(asc(s.ticketStatuses.sortOrder))
            .limit(1);
          if (open) await updateTicket({ db: tx, userId: null }, ticket.id, { statusId: open.id });
        }
        await storeAttachments(tx, config, ticket.id, msg.attachments);
        await log('appended', ticket.id, detail, tx);
      });
      await runTicketRules(db, 'ticket.updated', ticket.id);
      return { status: 'appended', ticketId: ticket.id };
    }
  }

  // New ticket: only from a known contact or a company's domain (or the fallback company).
  const sender = await resolveSender(db, msg.fromAddress, { fromName: msg.fromName, createContact: settings.inboundCreateContacts });
  const companyId = sender?.companyId ?? settings.inboundEmailCompanyId;
  if (!companyId) {
    const detail = 'Unknown sender: the address is not a contact and its domain belongs to no company (add the domain on the company, or the person as a contact)';
    await log('rejected', null, detail);
    return { status: 'rejected', ticketId: null, detail };
  }
  const [source] = await db
    .select({ id: s.ticketSources.id })
    .from(s.ticketSources)
    .where(inArray(sql`lower(${s.ticketSources.name})`, ['email', 'e-mail']));
  const ticket = await db.transaction(async (tx) => {
    const t = await createTicket(
      { db: tx, userId: null },
      {
        title: subject.slice(0, 255),
        description: [sender?.contactId ? null : `From: ${msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}`, body].filter(Boolean).join('\n\n').slice(0, 50000),
        companyId,
        contactId: sender?.contactId ?? null,
        sourceId: source?.id ?? null,
        queueId: settings.inboundEmailQueueId,
      },
    );
    await storeAttachments(tx, config, t.id, msg.attachments);
    await log('created', t.id, sender ? (sender.createdContact ? `New contact created: ${sender.createdContact}` : undefined) : 'Unknown sender — placed in the fallback company', tx);
    return t;
  });
  await runTicketRules(db, 'ticket.created', ticket.id);
  return { status: 'created', ticketId: (await getTicketRow(db, ticket.id)).id };
}

/** Polls the configured IMAP mailbox and processes unseen messages. */
export async function pollInbox(db: Db, config: Config, log: (msg: string) => void = () => {}) {
  const imap = await resolveImap(db, config);
  if (!imap) return { processed: 0 };
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: imap.password },
    logger: false,
  });
  await client.connect();
  let processed = 0;
  const lock = await client.getMailboxLock(imap.mailbox);
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids.slice(0, 25)) {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message || !message.source) continue;
      const parsed = await simpleParser(message.source);
      const from = parsed.from?.value[0];
      if (!from?.address) {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        continue;
      }
      const messageId = parsed.messageId ?? `uid-${uid}-${parsed.date?.toISOString() ?? ''}`;
      try {
        const r = await processInboundEmail(db, config, {
          messageId,
          fromAddress: from.address,
          fromName: from.name || null,
          subject: parsed.subject ?? '',
          text: parsed.text ?? '',
          attachments: parsed.attachments.map((a) => ({ fileName: a.filename ?? 'attachment', contentType: a.contentType, content: a.content })),
        });
        log(`message ${uid}: ${r.status}${r.ticketId ? ` ticket ${r.ticketId}` : ''}`);
        processed++;
      } catch (err) {
        // Keep going with the other messages; the failure is visible in the inbound log.
        await db
          .insert(s.inboundEmails)
          .values({ messageId, fromAddress: from.address, fromName: from.name || null, subject: parsed.subject ?? null, status: 'failed', detail: String((err as Error).message ?? err).slice(0, 1000) })
          .onConflictDoNothing();
        log(`message ${uid}: failed ${(err as Error).message}`);
      } finally {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
  return { processed };
}

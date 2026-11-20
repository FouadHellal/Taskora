import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { currentUser } from '../../lib/context.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { mailSettingsInputSchema, mailSettingsView, parseAddresses, resolveSmtp, saveMailSettings, transportFor } from '../../lib/mail.js';
import { getSystemSettings } from '../../lib/settings.js';
import { withSignature } from '../../jobs/email.js';
import { emailTextWithImages } from '../../lib/note-images.js';
import { addTicketNote, getTicketRow } from '../tickets/service.js';
import { runTicketRules } from '../automation/engine.js';

const testSchema = z.object({ to: z.string().trim().min(3).max(255) });

const ticketEmailSchema = z.object({
  to: z.array(z.string()).max(50).default([]),
  cc: z.array(z.string()).max(50).default([]),
  bcc: z.array(z.string()).max(50).default([]),
  subject: z.string().trim().min(1, 'Subject is required').max(500),
  body: z.string().trim().min(1, 'Message is required').max(50000),
  /** Ticket attachments to send along (ids from /attachments/ticket/:id). */
  attachmentIds: z.array(z.number().int().positive()).max(20).default([]),
  /** Record the message as a customer-visible note on the ticket. */
  saveAsNote: z.boolean().default(true),
  statusId: z.number().int().positive().nullable().optional(),
});

/** Maximum total size of attachments sent with one e-mail. */
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;

function smtpError(err: unknown) {
  return new AppError(502, 'smtp_error', `The mail server rejected the message: ${(err as Error).message}`.slice(0, 500));
}

export async function emailRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------- SMTP settings */

  app.get('/settings/email', { config: { perm: 'settings.manage' } }, async () => mailSettingsView(app.db, app.config));

  app.put('/settings/email', { config: { perm: 'settings.manage' } }, async (req) => {
    const input = mailSettingsInputSchema.parse(req.body);
    if (input.enabled && (!input.host || !input.from)) throw badRequest('Host and sender address are required', { fields: { host: input.host ? undefined : 'Required', from: input.from ? undefined : 'Required' } });
    if (input.from && !parseAddresses(input.from.replace(/^.*<([^>]+)>\s*$/, '$1')).valid.length) throw badRequest('Invalid sender address', { fields: { from: 'Use name@example.com or "Name <name@example.com>"' } });
    await saveMailSettings(app.db, app.config, input);
    const { password: _omit, ...logged } = input;
    await audit(app.db, req, { action: 'update', entityType: 'email_settings', changes: { ...logged, passwordChanged: input.password !== undefined } });
    return mailSettingsView(app.db, app.config);
  });

  app.post('/settings/email/test', { config: { perm: 'settings.manage' } }, async (req) => {
    const { to } = testSchema.parse(req.body);
    const addr = parseAddresses(to);
    if (!addr.valid.length || addr.invalid.length) throw badRequest('Enter one valid e-mail address');
    const smtp = await resolveSmtp(app.db, app.config);
    if (!smtp) throw badRequest('Outgoing e-mail is not configured yet — save the SMTP settings first');
    const settings = await getSystemSettings(app.db);
    try {
      await (app.mailTransport ?? transportFor(smtp)).sendMail({
        from: smtp.from,
        ...(smtp.replyTo ? { replyTo: smtp.replyTo } : {}),
        to: addr.valid[0],
        subject: `[${settings.organizationName}] Test e-mail from Taskora`,
        text: withSignature(`This is a test message sent by ${currentUser(req).email}.\nOutgoing e-mail works.`, smtp.signature),
      });
    } catch (err) {
      throw smtpError(err);
    }
    return { ok: true, source: smtp.source };
  });

  /* ------------------------------------------------- e-mail from a ticket */

  /** Pre-filled message for the compose dialog. */
  app.get('/tickets/:id/email/draft', { config: { perm: 'tickets.read' } }, async (req) => {
    const t = await getTicketRow(app.db, idOf(req));
    const smtp = await resolveSmtp(app.db, app.config);
    const [contact] = t.contactId ? await app.db.select().from(s.contacts).where(eq(s.contacts.id, t.contactId)) : [];
    const me = currentUser(req);
    const greeting = contact?.firstName ? `Hello ${contact.firstName},` : 'Hello,';
    return {
      enabled: !!smtp,
      from: smtp?.from ?? null,
      to: contact?.email ? [contact.email] : [],
      subject: `[${t.ticketNumber}] ${t.title}`,
      body: `${greeting}\n\n\n\n${me.firstName} ${me.lastName}`,
      signature: smtp?.signature ?? '',
    };
  });

  app.post('/tickets/:id/email', { config: { perm: 'tickets.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = ticketEmailSchema.parse(req.body);
    const ticket = await getTicketRow(app.db, id);
    const smtp = await resolveSmtp(app.db, app.config);
    if (!smtp) throw badRequest('Outgoing e-mail is not configured. An administrator can set it up in Administration → E-mail.');

    const to = parseAddresses(input.to);
    const cc = parseAddresses(input.cc);
    const bcc = parseAddresses(input.bcc);
    const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];
    if (invalid.length) throw badRequest(`Invalid e-mail address: ${invalid.slice(0, 3).join(', ')}`, { fields: { to: 'Check the addresses' } });
    if (!to.valid.length) throw badRequest('Add at least one recipient', { fields: { to: 'Required' } });

    // Keep the ticket number in the subject so replies thread back into the ticket.
    const subject = input.subject.includes(`[${ticket.ticketNumber}]`) ? input.subject : `[${ticket.ticketNumber}] ${input.subject}`;

    const files = input.attachmentIds.length
      ? await app.db
          .select()
          .from(s.attachments)
          .where(and(eq(s.attachments.entityType, 'ticket'), eq(s.attachments.entityId, id), inArray(s.attachments.id, input.attachmentIds)))
      : [];
    if (files.length !== input.attachmentIds.length) throw badRequest('One of the attachments does not belong to this ticket');
    if (files.reduce((n, f) => n + f.sizeBytes, 0) > MAX_ATTACH_BYTES) throw badRequest('Attachments exceed 20 MB in total');
    const root = resolve(app.config.UPLOAD_DIR);
    const attachments: { filename: string; contentType: string; content: Buffer }[] = await Promise.all(
      files.map(async (f) => ({ filename: f.fileName, contentType: f.mimeType, content: await readFile(join(root, f.storageKey)) })),
    );
    // Images pasted into the message are sent as attachments; the text names them.
    const mail = await emailTextWithImages(app.db, app.config.UPLOAD_DIR, id, input.body, input.attachmentIds);
    attachments.push(...mail.attachments);

    try {
      await (app.mailTransport ?? transportFor(smtp)).sendMail({
        from: smtp.from,
        ...(smtp.replyTo ? { replyTo: smtp.replyTo } : {}),
        to: to.valid,
        ...(cc.valid.length ? { cc: cc.valid } : {}),
        ...(bcc.valid.length ? { bcc: bcc.valid } : {}),
        subject,
        text: withSignature(mail.text, smtp.signature),
        attachments,
      });
    } catch (err) {
      throw smtpError(err);
    }

    const me = currentUser(req);
    const recipients = { to: to.valid, cc: cc.valid, bcc: bcc.valid };
    const result = await app.db.transaction(async (tx) => {
      let noteId: number | null = null;
      if (input.saveAsNote) {
        const header = [`To: ${to.valid.join(', ')}`, cc.valid.length ? `Cc: ${cc.valid.join(', ')}` : null, `Subject: ${subject}`].filter(Boolean).join('\n');
        const note = await addTicketNote({ db: tx, userId: me.id }, id, { body: `${header}\n\n${input.body}`, visibility: 'public', statusId: input.statusId ?? null, kind: 'email_out' });
        noteId = note.id;
      }
      await tx.insert(s.ticketEvents).values({ ticketId: id, userId: me.id, type: 'email_sent', data: { ...recipients, subject, noteId, attachments: files.map((f) => f.fileName) } });
      await audit(tx, req, { action: 'email', entityType: 'ticket', entityId: id, summary: `${ticket.ticketNumber}: e-mail to ${to.valid.join(', ')}`, changes: { ...recipients, subject } });
      return { noteId };
    });
    if (input.saveAsNote && input.statusId && input.statusId !== ticket.statusId) await runTicketRules(app.db, 'ticket.updated', id);
    return reply.status(201).send({ ok: true, ...recipients, subject, noteId: result.noteId });
  });
}

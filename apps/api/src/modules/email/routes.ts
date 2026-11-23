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
import { sendBranded } from '../../jobs/client-email.js';
import { mailLang, mailTranslator } from '../../jobs/mail-i18n.js';
import { loadMailBrand, renderEmail, renderSignature } from '../../lib/mail-template.js';
import { emailTextWithImages } from '../../lib/note-images.js';
import { addTicketNote, getTicketRow } from '../tickets/service.js';
import { runTicketRules } from '../automation/engine.js';

const testSchema = z.object({ to: z.string().trim().min(3).max(255) });
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const previewSchema = z.object({ signature: z.string().max(20000).optional(), headerColor: color.optional(), accentColor: color.optional(), footer: z.string().max(1000).optional() });

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
    const tr = mailTranslator(mailLang(settings.language));
    const me = currentUser(req);
    try {
      await sendBranded(app.db, app.config, smtp, app.mailTransport ?? transportFor(smtp), addr.valid[0]!, tr('testSubject'), {
        preheader: tr('testP1', { email: me.email }),
        eyebrow: 'Taskora',
        heading: tr('testHeading'),
        greeting: tr('helloAll'),
        paragraphs: [tr('testP1', { email: me.email })],
        card: { ref: 'TKA-000000', title: 'Example ticket', status: { label: 'In progress' }, facts: [[tr('ref'), 'TKA-000000'], [tr('priority'), 'Medium']] },
        footer: tr('footerClient', { org: settings.organizationName }),
        signature: { sender: `${me.firstName} ${me.lastName}`.trim() || tr('team', { org: settings.organizationName }) },
      });
    } catch (err) {
      throw smtpError(err);
    }
    return { ok: true, source: smtp.source };
  });

  /** Renders a sample client e-mail with the (unsaved) look and signature, for the preview on Administration → E-mail. */
  app.post('/settings/email/preview', { config: { perm: 'settings.manage' } }, async (req) => {
    const input = previewSchema.parse(req.body ?? {});
    const settings = await getSystemSettings(app.db);
    const smtp = await resolveSmtp(app.db, app.config);
    const brand = await loadMailBrand(app.db, app.config, { signature: input.signature ?? smtp?.signature ?? '' }, settings);
    if (input.headerColor) brand.headerColor = input.headerColor;
    if (input.accentColor) brand.accentColor = input.accentColor;
    if (input.footer !== undefined) brand.footerNote = input.footer;
    // The preview has no public address to load the logo from: embed it.
    if (brand.logo) brand.logoUrl = `data:${brand.logo.contentType};base64,${brand.logo.content.toString('base64')}`;
    const tr = mailTranslator(mailLang(settings.language));
    const me = currentUser(req);
    const org = settings.organizationName;
    const { html } = renderEmail(brand, {
      preheader: tr('createdP1', { org, ref: 'TKA-000123' }),
      eyebrow: tr('eyebrowCreated'),
      heading: tr('createdHeading'),
      greeting: tr('hello', { name: 'Amina' }),
      paragraphs: [tr('createdP1', { org, ref: 'TKA-000123' }), tr('createdP2')],
      card: {
        ref: 'TKA-000123',
        title: 'Outlook keeps asking for the password',
        status: { label: 'New', color: '#2563eb' },
        facts: [
          [tr('ref'), 'TKA-000123'],
          [tr('priority'), 'Medium'],
          [tr('openedOn'), new Intl.DateTimeFormat(mailLang(settings.language), { dateStyle: 'medium', timeStyle: 'short', timeZone: settings.timezone }).format(new Date())],
        ],
      },
      quote: { label: tr('description'), text: 'Since this morning Outlook asks for my password every few minutes.' },
      button: { label: tr('follow'), url: `${brand.base || 'https://example.com'}/portal` },
      hint: tr('replyHint', { ref: 'TKA-000123' }),
      footer: tr('footerClient', { org }),
      signature: { sender: `${me.firstName} ${me.lastName}`.trim() },
    });
    // The header logo is an inline attachment in real e-mails; inline it as data for the preview.
    return { html: brand.logo ? html.replace(`cid:${brand.logo.cid}`, `data:${brand.logo.contentType};base64,${brand.logo.content.toString('base64')}`) : html };
  });

  /* ------------------------------------------------- e-mail from a ticket */

  /** Pre-filled message for the compose dialog. */
  app.get('/tickets/:id/email/draft', { config: { perm: 'tickets.read' } }, async (req) => {
    const t = await getTicketRow(app.db, idOf(req));
    const smtp = await resolveSmtp(app.db, app.config);
    const [contact] = t.contactId ? await app.db.select().from(s.contacts).where(eq(s.contacts.id, t.contactId)) : [];
    const me = currentUser(req);
    const greeting = contact?.firstName ? `Hello ${contact.firstName},` : 'Hello,';
    const settings = await getSystemSettings(app.db);
    const brand = await loadMailBrand(app.db, app.config, smtp, settings);
    const sig = smtp ? renderSignature(smtp.signature, { sender: `${me.firstName} ${me.lastName}`.trim(), organization: settings.organizationName, logo: brand.logoUrl, portal: brand.base ? `${brand.base}/portal` : '' }) : null;
    return {
      enabled: !!smtp,
      from: smtp?.from ?? null,
      to: contact?.email ? [contact.email] : [],
      subject: `[${t.ticketNumber}] ${t.title}`,
      // The signature (with the sender's name) is added when the e-mail is sent.
      body: sig ? `${greeting}\n\n` : `${greeting}\n\n\n\n${me.firstName} ${me.lastName}`,
      signature: sig?.text ?? '',
      signatureHtml: sig?.html ?? '',
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

    const me = currentUser(req);
    const settings = await getSystemSettings(app.db);
    const tr = mailTranslator(mailLang(settings.language));
    try {
      await sendBranded(
        app.db,
        app.config,
        smtp,
        app.mailTransport ?? transportFor(smtp),
        to.valid,
        subject,
        {
          preheader: mail.text.slice(0, 120),
          paragraphs: mail.text.split(/\n{2,}/).filter((x) => x.trim()),
          footer: tr('ticketFooter', { ref: ticket.ticketNumber }),
          signature: { sender: `${me.firstName} ${me.lastName}`.trim() || tr('team', { org: settings.organizationName }) },
        },
        { cc: cc.valid, bcc: bcc.valid, attachments },
      );
    } catch (err) {
      throw smtpError(err);
    }

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

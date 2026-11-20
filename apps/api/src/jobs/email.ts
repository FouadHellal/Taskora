import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { contacts, notifications, ticketEvents, ticketNotes, tickets, users } from '../db/schema/index.js';
import { getSystemSettings } from '../lib/settings.js';
import { resolveSmtp, transportFor } from '../lib/mail.js';
import { emailTextWithImages } from '../lib/note-images.js';
import { noteImagesToText } from '@taskora/shared';

export function withSignature(body: string, signature: string) {
  return signature.trim() ? `${body.replace(/\s+$/, '')}\n\n-- \n${signature.trim()}` : body;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Sends pending in-app notifications by e-mail. Notifications older than a
 * day are never mailed (e.g. after enabling SMTP on an existing install), and
 * users can opt out with the `emailNotifications: false` preference.
 */
export async function dispatchNotificationEmails(db: Db, config: Config, transport?: Transporter, batch = 50) {
  const smtp = await resolveSmtp(db, config);
  if (!smtp) return { sent: 0, skipped: 0, failed: 0 };
  const rows = await db
    .select({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      link: notifications.link,
      email: users.email,
      firstName: users.firstName,
      isActive: users.isActive,
      preferences: users.preferences,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(isNull(notifications.emailStatus), gt(notifications.createdAt, sql`now() - interval '1 day'`)))
    .orderBy(notifications.id)
    .limit(batch);
  if (!rows.length) return { sent: 0, skipped: 0, failed: 0 };

  const t = transport ?? transportFor(smtp);
  const settings = await getSystemSettings(db);
  const base = (config.PUBLIC_URL ?? '').replace(/\/$/, '');
  const result = { sent: 0, skipped: 0, failed: 0 };
  const mark = (ids: number[], status: string) =>
    ids.length ? db.update(notifications).set({ emailStatus: status, emailedAt: new Date() }).where(inArray(notifications.id, ids)) : null;

  const skipped: number[] = [];
  for (const r of rows) {
    if (!r.isActive || (r.preferences as Record<string, unknown>).emailNotifications === false) {
      skipped.push(r.id);
      continue;
    }
    const url = r.link && base ? `${base}${r.link}` : null;
    const body = r.body ? noteImagesToText(r.body) : null;
    try {
      await t.sendMail({
        from: smtp.from,
        to: r.email,
        subject: `[${settings.organizationName}] ${r.title}`,
        text: [`Hello ${r.firstName},`, '', r.title, body ?? '', url ? `\nOpen: ${url}` : ''].join('\n'),
        html: `<p>Hello ${escapeHtml(r.firstName)},</p><p><strong>${escapeHtml(r.title)}</strong></p>${body ? `<p>${escapeHtml(body)}</p>` : ''}${
          url ? `<p><a href="${escapeHtml(url)}">Open in ${escapeHtml(settings.organizationName)}</a></p>` : ''
        }<p style="color:#888;font-size:12px">You receive this because of your Taskora notification settings.</p>`,
      });
      await mark([r.id], 'sent');
      result.sent++;
    } catch {
      await mark([r.id], 'failed');
      result.failed++;
    }
  }
  await mark(skipped, 'skipped');
  result.skipped = skipped.length;
  return result;
}

/**
 * E-mails a customer-visible ticket note to the ticket contact. The ticket
 * number in the subject lets the inbound poller thread the customer's reply.
 */
export async function sendCustomerNote(db: Db, config: Config, noteId: number, transport?: Transporter) {
  const smtp = await resolveSmtp(db, config);
  if (!smtp) throw new Error('SMTP is not configured');
  const [row] = await db
    .select({
      body: ticketNotes.body,
      visibility: ticketNotes.visibility,
      ticketId: tickets.id,
      ticketNumber: tickets.ticketNumber,
      title: tickets.title,
      email: contacts.email,
      firstName: contacts.firstName,
      author: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
    })
    .from(ticketNotes)
    .innerJoin(tickets, eq(tickets.id, ticketNotes.ticketId))
    .leftJoin(contacts, eq(contacts.id, tickets.contactId))
    .leftJoin(users, eq(users.id, ticketNotes.userId))
    .where(eq(ticketNotes.id, noteId));
  if (!row || row.visibility !== 'public' || !row.email) return { sent: false };
  const settings = await getSystemSettings(db);
  const t = transport ?? transportFor(smtp);
  // Pasted images go out as attachments; the text names them instead of showing raw markdown.
  const mail = await emailTextWithImages(db, config.UPLOAD_DIR, row.ticketId, row.body);
  await t.sendMail({
    from: smtp.from,
    ...(smtp.replyTo ? { replyTo: smtp.replyTo } : {}),
    to: row.email,
    subject: `[${row.ticketNumber}] ${row.title}`,
    ...(mail.attachments.length ? { attachments: mail.attachments } : {}),
    text: `Hello ${row.firstName ?? ''},\n\n${mail.text}\n\n${row.author ?? settings.organizationName}\n${settings.organizationName}\n\nPlease keep [${row.ticketNumber}] in the subject when replying.`,
  });
  await db.insert(ticketEvents).values({ ticketId: row.ticketId, userId: null, type: 'email_sent', data: { to: row.email, noteId } });
  return { sent: true };
}

/** Marks old pending notifications so they are never mailed late. */
export async function expireStaleEmails(db: Db) {
  await db
    .update(notifications)
    .set({ emailStatus: 'expired' })
    .where(and(isNull(notifications.emailStatus), sql`${notifications.createdAt} <= now() - interval '1 day'`));
}

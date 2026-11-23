import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { contacts, notifications, ticketEvents, ticketNotes, tickets, users } from '../db/schema/index.js';
import { getSystemSettings } from '../lib/settings.js';
import { resolveSmtp, transportFor } from '../lib/mail.js';
import { emailTextWithImages } from '../lib/note-images.js';
import { noteImagesToText } from '@taskora/shared';
import { sendBranded, sendReplyEmail } from './client-email.js';
import { loadMailBrand } from '../lib/mail-template.js';
import { mailLang, mailTranslator } from './mail-i18n.js';

export function withSignature(body: string, signature: string) {
  return signature.trim() ? `${body.replace(/\s+$/, '')}\n\n-- \n${signature.trim()}` : body;
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
  const brand = await loadMailBrand(db, config, smtp, settings);
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
      const tr = mailTranslator(mailLang((r.preferences as Record<string, unknown>).language as string | undefined ?? settings.language));
      await sendBranded(
        db,
        config,
        smtp,
        t,
        r.email,
        r.title,
        {
          preheader: body?.slice(0, 120) ?? r.title,
          heading: r.title,
          greeting: tr('hello', { name: r.firstName }),
          paragraphs: body ? [body] : [],
          button: url ? { label: tr('openTaskora'), url } : null,
          footer: tr('notifFooter'),
        },
        { brand },
      );
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
  if (!row || row.visibility !== 'public') return { sent: false };
  // Pasted images go out as attachments; the text names them instead of showing raw markdown.
  const mail = await emailTextWithImages(db, config.UPLOAD_DIR, row.ticketId, row.body);
  const res = await sendReplyEmail(db, config, noteId, mail.attachments, mail.text, transport);
  if (!res.sent) {
    if (res.reason === 'opted_out') await db.insert(ticketEvents).values({ ticketId: row.ticketId, userId: null, type: 'email_skipped', data: { to: res.to ?? row.email, noteId, reason: 'The contact turned off reply e-mails' } });
    return { sent: false };
  }
  await db.insert(ticketEvents).values({ ticketId: row.ticketId, userId: null, type: 'email_sent', data: { to: res.to, noteId } });
  return { sent: true };
}

/** Marks old pending notifications so they are never mailed late. */
export async function expireStaleEmails(db: Db) {
  await db
    .update(notifications)
    .set({ emailStatus: 'expired' })
    .where(and(isNull(notifications.emailStatus), sql`${notifications.createdAt} <= now() - interval '1 day'`));
}

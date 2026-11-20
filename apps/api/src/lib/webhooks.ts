import { createHmac, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import * as s from '../db/schema/index.js';
import { enqueue } from '../jobs/queue.js';
import { decryptJson } from './crypto.js';

/**
 * Outgoing webhooks. Business events are queued (one job per subscribed webhook) and the
 * worker POSTs them as JSON with an HMAC-SHA256 signature, retrying with backoff.
 * Payload: { id, event, occurredAt, data }. Headers: X-Taskora-Event, X-Taskora-Delivery,
 * X-Taskora-Signature: sha256=<hex HMAC of the raw body with the webhook secret>.
 */
export const WEBHOOK_EVENTS = {
  'ticket.created': 'A ticket was created (UI, e-mail, portal, API, recurring)',
  'ticket.updated': 'A ticket changed (status, assignment, fields…)',
  'ticket.note_added': 'A note was added to a ticket',
  'ticket.sla_breached': 'A ticket breached an SLA target',
  'time_entry.created': 'Time was logged',
  'company.created': 'A company was created',
  'contact.created': 'A contact was created',
  'webhook.test': 'Test event sent from the settings page',
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

/** Queues `event` for every active webhook subscribed to it. Never throws. */
export async function emitEvent(db: Tx, event: WebhookEvent, data: Record<string, unknown>, onlyWebhookId?: number) {
  try {
    const hooks = await db
      .select({ id: s.webhooks.id })
      .from(s.webhooks)
      .where(
        onlyWebhookId
          ? eq(s.webhooks.id, onlyWebhookId)
          : and(eq(s.webhooks.isActive, true), sql`(${event} = any(${s.webhooks.events}) or '*' = any(${s.webhooks.events}))`),
      );
    if (!hooks.length) return 0;
    const occurredAt = new Date().toISOString();
    for (const h of hooks) {
      await enqueue(db, 'webhook.deliver', { webhookId: h.id, deliveryId: randomUUID(), event, occurredAt, data: JSON.parse(JSON.stringify(data)) }, { maxAttempts: 6 });
    }
    return hooks.length;
  } catch {
    return 0;
  }
}

/** Ticket events carry the ticket with readable names, so flows rarely need a second call. */
export async function emitTicketEvent(db: Tx, event: WebhookEvent, ticketId: number, extra: Record<string, unknown> = {}) {
  try {
    const [any] = await db.select({ id: s.webhooks.id }).from(s.webhooks).where(eq(s.webhooks.isActive, true)).limit(1);
    if (!any) return 0;
    const res = (await db.execute(sql`
      select t.id, t.ticket_number as "ticketNumber", t.title, t.description, t.company_id as "companyId", c.name as "companyName",
             t.contact_id as "contactId", trim(coalesce(ct.first_name,'') || ' ' || coalesce(ct.last_name,'')) as "contactName", ct.email as "contactEmail",
             t.status_id as "statusId", st.name as "statusName", t.priority_id as "priorityId", pr.name as "priorityName",
             t.queue_id as "queueId", q.name as "queueName", t.assigned_user_id as "assignedUserId",
             trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) as "assigneeName", u.email as "assigneeEmail",
             t.due_at as "dueAt", t.created_at as "createdAt", t.updated_at as "updatedAt", t.resolved_at as "resolvedAt", t.tags, t.custom_fields as "customFields"
      from tickets t
      left join companies c on c.id = t.company_id
      left join contacts ct on ct.id = t.contact_id
      left join ticket_statuses st on st.id = t.status_id
      left join ticket_priorities pr on pr.id = t.priority_id
      left join queues q on q.id = t.queue_id
      left join users u on u.id = t.assigned_user_id
      where t.id = ${ticketId}`)) as unknown as { rows: Record<string, unknown>[] };
    const ticket = res.rows[0];
    if (!ticket) return 0;
    return emitEvent(db, event, { ticket, ...extra });
  } catch {
    return 0;
  }
}

export async function deliverWebhook(db: Db, config: Config, payload: Record<string, unknown>) {
  const [hook] = await db.select().from(s.webhooks).where(eq(s.webhooks.id, Number(payload.webhookId)));
  if (!hook) return { skipped: 'webhook deleted' };
  if (!hook.isActive && payload.event !== 'webhook.test') return { skipped: 'webhook disabled' };
  const body = JSON.stringify({ id: payload.deliveryId, event: payload.event, occurredAt: payload.occurredAt, data: payload.data });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'Taskora-Webhooks/1.0',
    'x-taskora-event': String(payload.event),
    'x-taskora-delivery': String(payload.deliveryId),
  };
  if (hook.secretEncrypted) {
    const secret = decryptJson<string>(config.encryptionKey, hook.secretEncrypted);
    headers['x-taskora-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }
  let status = 0;
  let error: string | null = null;
  try {
    const res = await fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    status = res.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 500);
  }
  await db
    .update(s.webhooks)
    .set({ lastStatus: status || null, lastError: error, lastDeliveredAt: new Date() })
    .where(eq(s.webhooks.id, hook.id));
  if (error) throw new Error(error);
  return { status };
}

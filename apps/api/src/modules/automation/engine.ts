import { and, asc, eq, sql } from 'drizzle-orm';
import type { WorkflowAction, WorkflowCondition, WorkflowTrigger } from '@taskora/shared';
import type { Db, Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { addTicketNote, getTicketRow, updateTicket, type TicketRow } from '../tickets/service.js';
import { emitTicketEvent } from '../../lib/webhooks.js';
import { enqueue } from '../../jobs/queue.js';
import { notify } from '../notifications/service.js';

export function matchesConditions(ticket: Record<string, unknown>, conditions: WorkflowCondition[]): boolean {
  return conditions.every((c) => {
    const actual = ticket[c.field];
    const str = actual === null || actual === undefined ? '' : String(actual);
    const values = Array.isArray(c.value) ? c.value.map(String) : c.value === null || c.value === undefined ? [] : [String(c.value)];
    switch (c.operator) {
      case 'eq':
        return values.length > 0 && str === values[0];
      case 'neq':
        return values.length === 0 ? str !== '' : str !== values[0];
      case 'in':
        return values.includes(str);
      case 'contains':
        return values.length > 0 && str.toLowerCase().includes(values[0]!.toLowerCase());
      case 'is_empty':
        return str === '';
      case 'is_not_empty':
        return str !== '';
      default:
        return false;
    }
  });
}

async function applyAction(tx: Tx, ticket: TicketRow, action: WorkflowAction, ruleName: string): Promise<string> {
  const ctx = { db: tx, userId: null, automation: true };
  const num = action.value === null || action.value === undefined || action.value === '' ? null : Number(action.value);
  switch (action.type) {
    case 'set_queue':
      await updateTicket(ctx, ticket.id, { queueId: num });
      return `queue → ${num}`;
    case 'set_priority':
      if (num) await updateTicket(ctx, ticket.id, { priorityId: num });
      return `priority → ${num}`;
    case 'set_status':
      if (num) await updateTicket(ctx, ticket.id, { statusId: num });
      return `status → ${num}`;
    case 'assign_user':
      await updateTicket(ctx, ticket.id, { assignedUserId: num });
      return `assigned → ${num}`;
    case 'set_sla':
      await updateTicket(ctx, ticket.id, { slaId: num });
      return `SLA → ${num}`;
    case 'add_tag': {
      const tag = String(action.value ?? '').trim();
      const current = (await getTicketRow(tx, ticket.id)).tags;
      if (tag && !current.includes(tag)) await updateTicket(ctx, ticket.id, { tags: [...current, tag] });
      return `tag + ${tag}`;
    }
    case 'add_note':
      await addTicketNote(ctx, ticket.id, { body: String(action.value ?? ''), visibility: 'internal', kind: 'automation' });
      return 'note added';
    case 'notify_user':
    case 'notify_assignee': {
      const target = action.type === 'notify_user' ? num : (await getTicketRow(tx, ticket.id)).assignedUserId;
      if (target) {
        await notify(tx, [target], {
          type: 'workflow',
          title: `${ticket.ticketNumber}: ${ruleName}`,
          body: ticket.title,
          link: `/tickets/${ticket.id}`,
          entityType: 'ticket',
          entityId: ticket.id,
        });
      }
      return `notified ${target ?? 'nobody'}`;
    }
    default:
      return 'unknown action';
  }
}

/**
 * Evaluates active rules for a trigger against one ticket. Actions run with
 * `automation: true`, and automated changes never re-enter this function,
 * which prevents rule loops. `dedupeKey` makes time-based triggers fire at
 * most once per ticket/status period.
 */
export async function runTicketRules(
  db: Db,
  trigger: WorkflowTrigger,
  ticketId: number,
  opts: { dedupeKey?: string; ruleIds?: number[] } = {},
): Promise<number> {
  if (!opts.ruleIds && (trigger === 'ticket.created' || trigger === 'ticket.updated' || trigger === 'ticket.sla_breached')) {
    await emitTicketEvent(db, trigger, ticketId);
  }
  // Proactive e-mails (IT alert + client confirmation, "resolved" notice); the worker checks settings and preferences.
  if (!opts.ruleIds && trigger === 'ticket.created') await enqueue(db, 'email.ticket_created', { ticketId }, { maxAttempts: 3 });
  // Automatic interpretation of the request (internal note).
  if (!opts.ruleIds && trigger === 'ticket.created') await enqueue(db, 'tickets.analyze', { ticketId }, { maxAttempts: 2 });
  if (!opts.ruleIds && trigger === 'ticket.updated') {
    await enqueue(db, 'email.ticket_updated', { ticketId }, { dedupeKey: `email.ticket_updated:${ticketId}`, maxAttempts: 3, runAt: new Date(Date.now() + 15_000) });
  }
  const rules = await db
    .select()
    .from(s.workflowRules)
    .where(and(eq(s.workflowRules.trigger, trigger), eq(s.workflowRules.isActive, true)))
    .orderBy(asc(s.workflowRules.sortOrder), asc(s.workflowRules.id));
  let fired = 0;
  for (const rule of rules) {
    if (opts.ruleIds && !opts.ruleIds.includes(rule.id)) continue;
    const ticket = await getTicketRow(db, ticketId).catch(() => null);
    if (!ticket) return fired;
    if (!matchesConditions(ticket as unknown as Record<string, unknown>, rule.conditions as WorkflowCondition[])) continue;
    const dedupeKey = opts.dedupeKey ?? null;
    try {
      const executed = await db.transaction(async (tx) => {
        const [exec] = await tx
          .insert(s.workflowExecutions)
          .values({ ruleId: rule.id, ticketId, trigger, status: 'running', dedupeKey })
          .onConflictDoNothing()
          .returning();
        if (!exec) return false; // already executed for this dedupe key
        const results: string[] = [];
        for (const action of rule.actions as WorkflowAction[]) results.push(await applyAction(tx, ticket, action, rule.name));
        await tx.update(s.workflowExecutions).set({ status: 'success', result: results }).where(eq(s.workflowExecutions.id, exec.id));
        await tx
          .update(s.workflowRules)
          .set({ executionCount: sql`${s.workflowRules.executionCount} + 1`, lastExecutedAt: new Date() })
          .where(eq(s.workflowRules.id, rule.id));
        await tx.insert(s.ticketEvents).values({ ticketId, userId: null, type: 'workflow', data: { ruleId: rule.id, rule: rule.name, results } });
        return true;
      });
      if (executed) fired++;
    } catch (err) {
      await db
        .insert(s.workflowExecutions)
        .values({ ruleId: rule.id, ticketId, trigger, status: 'failed', error: String((err as Error).message ?? err).slice(0, 1000) });
    }
    if (rule.stopProcessing) break;
  }
  return fired;
}

/** Periodic evaluation of "ticket remains in status for N minutes" rules. */
export async function runStatusAgeRules(db: Db, now = new Date()): Promise<number> {
  const rules = await db
    .select()
    .from(s.workflowRules)
    .where(and(eq(s.workflowRules.trigger, 'ticket.status_age'), eq(s.workflowRules.isActive, true)));
  let fired = 0;
  for (const rule of rules) {
    const delay = rule.delayMinutes ?? 0;
    const cutoff = new Date(now.getTime() - delay * 60_000);
    const candidates = await db
      .select({ id: s.tickets.id, statusChangedAt: s.tickets.statusChangedAt })
      .from(s.tickets)
      .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
      .where(sql`${s.tickets.statusChangedAt} <= ${cutoff} and ${s.ticketStatuses.category} not in ('closed')`)
      .limit(500);
    for (const c of candidates) {
      fired += await runTicketRules(db, 'ticket.status_age', c.id, {
        ruleIds: [rule.id],
        dedupeKey: `${c.id}:${c.statusChangedAt.toISOString()}`,
      });
    }
  }
  return fired;
}

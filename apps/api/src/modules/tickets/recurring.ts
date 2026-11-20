import type { FastifyInstance } from 'fastify';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { optId, optNumber, optText, reqId, reqText } from '@taskora/shared';
import type { Db } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { currentUser } from '../../lib/context.js';
import { createTicket } from './service.js';
import { runTicketRules } from '../automation/engine.js';

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;

export const recurringSchema = z.object({
  name: reqText(120),
  companyId: reqId,
  contactId: optId,
  configurationItemId: optId,
  title: reqText(255),
  description: optText(20000),
  queueId: optId,
  priorityId: optId,
  ticketTypeId: optId,
  issueTypeId: optId,
  subIssueTypeId: optId,
  assignedUserId: optId,
  estimatedHours: optNumber,
  frequency: z.enum(FREQUENCIES).default('monthly'),
  interval: z.coerce.number().int().min(1).max(365).default(1),
  dueInHours: z.coerce.number().int().min(1).max(24 * 365).nullish().transform((v) => v ?? null),
  nextRunAt: z.string().min(1),
  isActive: z.boolean().default(true),
});

/** Next occurrence after `from` (calendar arithmetic in UTC). */
export function nextOccurrence(from: Date, frequency: (typeof FREQUENCIES)[number], interval: number): Date {
  const d = new Date(from);
  switch (frequency) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + interval);
      break;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7 * interval);
      break;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + interval);
      break;
    case 'quarterly':
      d.setUTCMonth(d.getUTCMonth() + 3 * interval);
      break;
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + interval);
      break;
  }
  return d;
}

/** Creates tickets for every due schedule; skipped occurrences are not back-filled. */
export async function runRecurringTickets(db: Db, now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(s.recurringTickets)
    .where(and(eq(s.recurringTickets.isActive, true), lte(s.recurringTickets.nextRunAt, now)))
    .orderBy(asc(s.recurringTickets.nextRunAt))
    .limit(100);
  let created = 0;
  for (const r of due) {
    const ticket = await db.transaction(async (tx) => {
      // Re-check inside the transaction so concurrent workers never double-create.
      const [locked] = await tx.execute<{ id: number }>(sql`select id from recurring_tickets where id = ${r.id} and next_run_at <= ${now} for update skip locked`).then((x) => x.rows);
      if (!locked) return null;
      const t = await createTicket(
        { db: tx, userId: null },
        {
          title: r.title,
          description: r.description,
          companyId: r.companyId,
          contactId: r.contactId,
          configurationItemId: r.configurationItemId,
          queueId: r.queueId,
          priorityId: r.priorityId,
          ticketTypeId: r.ticketTypeId,
          issueTypeId: r.issueTypeId,
          subIssueTypeId: r.subIssueTypeId,
          assignedUserId: r.assignedUserId,
          estimatedHours: r.estimatedHours,
          dueAt: r.dueInHours ? new Date(now.getTime() + r.dueInHours * 3600_000).toISOString() : null,
          tags: ['recurring'],
        },
      );
      let next = nextOccurrence(r.nextRunAt, r.frequency as (typeof FREQUENCIES)[number], r.interval);
      while (next <= now) next = nextOccurrence(next, r.frequency as (typeof FREQUENCIES)[number], r.interval);
      await tx.update(s.recurringTickets).set({ nextRunAt: next, lastRunAt: now, lastTicketId: t.id }).where(eq(s.recurringTickets.id, r.id));
      return t;
    });
    if (ticket) {
      created++;
      await runTicketRules(db, 'ticket.created', ticket.id);
    }
  }
  return created;
}

export async function recurringRoutes(app: FastifyInstance) {
  app.get('/recurring-tickets', { config: { perm: 'tickets.read' } }, async () => {
    const rows = await app.db
      .select({
        r: s.recurringTickets,
        companyName: s.companies.name,
        assigneeName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        lastTicketNumber: s.tickets.ticketNumber,
      })
      .from(s.recurringTickets)
      .innerJoin(s.companies, eq(s.companies.id, s.recurringTickets.companyId))
      .leftJoin(s.users, eq(s.users.id, s.recurringTickets.assignedUserId))
      .leftJoin(s.tickets, eq(s.tickets.id, s.recurringTickets.lastTicketId))
      .orderBy(asc(s.recurringTickets.nextRunAt));
    return { data: rows.map((x) => ({ ...x.r, companyName: x.companyName, assigneeName: x.assigneeName, lastTicketNumber: x.lastTicketNumber })) };
  });

  const parse = (body: unknown) => {
    const input = recurringSchema.parse(body);
    const nextRunAt = new Date(input.nextRunAt);
    if (Number.isNaN(nextRunAt.getTime())) throw badRequest('Invalid first run date', { fields: { nextRunAt: 'Invalid date/time' } });
    return { ...input, nextRunAt };
  };

  app.post('/recurring-tickets', { config: { perm: 'tickets.write' } }, async (req, reply) => {
    const [row] = await app.db.insert(s.recurringTickets).values({ ...parse(req.body), createdById: currentUser(req).id }).returning();
    await audit(app.db, req, { action: 'create', entityType: 'recurring_ticket', entityId: row!.id, summary: row!.name });
    return reply.status(201).send(row);
  });

  app.put('/recurring-tickets/:id', { config: { perm: 'tickets.write' } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.update(s.recurringTickets).set(parse(req.body)).where(eq(s.recurringTickets.id, id)).returning();
    if (!row) throw notFound('Recurring ticket');
    await audit(app.db, req, { action: 'update', entityType: 'recurring_ticket', entityId: id, summary: row.name });
    return row;
  });

  app.delete('/recurring-tickets/:id', { config: { perm: 'tickets.write', forceDelete: { table: 'recurring_tickets' } } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.delete(s.recurringTickets).where(eq(s.recurringTickets.id, id)).returning();
    if (!row) throw notFound('Recurring ticket');
    await audit(app.db, req, { action: 'delete', entityType: 'recurring_ticket', entityId: id, summary: row.name });
    return { ok: true };
  });

  /** Creates the next ticket immediately and advances the schedule. */
  app.post('/recurring-tickets/:id/run', { config: { perm: 'tickets.write' } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.select().from(s.recurringTickets).where(eq(s.recurringTickets.id, id));
    if (!row) throw notFound('Recurring ticket');
    const now = new Date();
    await app.db.update(s.recurringTickets).set({ nextRunAt: now }).where(eq(s.recurringTickets.id, id));
    await runRecurringTickets(app.db, now);
    const [after] = await app.db.select().from(s.recurringTickets).where(eq(s.recurringTickets.id, id));
    return after;
  });
}

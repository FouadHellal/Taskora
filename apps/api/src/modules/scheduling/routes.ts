import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { serviceCallSchema } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { idList, intParam } from '../../lib/query.js';
import { currentUser } from '../../lib/context.js';
import { notify } from '../notifications/service.js';
import type { Tx } from '../../db/client.js';

async function loadCalls(db: Tx, where: ReturnType<typeof and>) {
  const calls = await db
    .select({ call: s.serviceCalls, companyName: s.companies.name })
    .from(s.serviceCalls)
    .innerJoin(s.companies, eq(s.companies.id, s.serviceCalls.companyId))
    .where(where)
    .orderBy(asc(s.serviceCalls.startAt));
  if (!calls.length) return [];
  const ids = calls.map((c) => c.call.id);
  const [users, tickets] = await Promise.all([
    db
      .select({ serviceCallId: s.serviceCallUsers.serviceCallId, id: s.users.id, name: sql<string>`${s.users.firstName} || ' ' || ${s.users.lastName}` })
      .from(s.serviceCallUsers)
      .innerJoin(s.users, eq(s.users.id, s.serviceCallUsers.userId))
      .where(inArray(s.serviceCallUsers.serviceCallId, ids)),
    db
      .select({ serviceCallId: s.serviceCallTickets.serviceCallId, id: s.tickets.id, ticketNumber: s.tickets.ticketNumber, title: s.tickets.title })
      .from(s.serviceCallTickets)
      .innerJoin(s.tickets, eq(s.tickets.id, s.serviceCallTickets.ticketId))
      .where(inArray(s.serviceCallTickets.serviceCallId, ids)),
  ]);
  return calls.map((c) => ({
    ...c.call,
    companyName: c.companyName,
    users: users.filter((u) => u.serviceCallId === c.call.id),
    tickets: tickets.filter((t) => t.serviceCallId === c.call.id),
  }));
}

export async function schedulingRoutes(app: FastifyInstance) {
  app.get('/service-calls', { config: { perm: 'tickets.read' } }, async (req) => {
    const q = req.query as Record<string, string>;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 30 * 86400_000);
    const me = currentUser(req);
    const userIds = q.userId === 'me' ? [me.id] : idList(q.userId);
    const where = and(
      lt(s.serviceCalls.startAt, to),
      gte(s.serviceCalls.endAt, from),
      intParam(q.companyId) ? eq(s.serviceCalls.companyId, intParam(q.companyId)!) : undefined,
      intParam(q.ticketId) ? sql`exists (select 1 from service_call_tickets x where x.service_call_id = ${s.serviceCalls.id} and x.ticket_id = ${intParam(q.ticketId)!})` : undefined,
      userIds.length ? sql`exists (select 1 from service_call_users x where x.service_call_id = ${s.serviceCalls.id} and x.user_id in ${userIds})` : undefined,
    );
    return { data: await loadCalls(app.db, where) };
  });

  const save = async (id: number | null, body: unknown, actorId: number) => {
    const input = serviceCallSchema.parse(body);
    const startAt = new Date(input.startAt);
    const endAt = new Date(input.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) throw badRequest('End must be after start', { fields: { endAt: 'Must be after the start' } });
    return app.db.transaction(async (tx) => {
      if (input.ticketIds.length) {
        const ts = await tx.select({ id: s.tickets.id, companyId: s.tickets.companyId }).from(s.tickets).where(inArray(s.tickets.id, input.ticketIds));
        if (ts.some((t) => t.companyId !== input.companyId)) throw badRequest('All tickets must belong to the service call company');
      }
      const values = { title: input.title, description: input.description, companyId: input.companyId, startAt, endAt, status: input.status };
      let callId = id;
      let previousUsers: number[] = [];
      if (callId) {
        const [u] = await tx.update(s.serviceCalls).set(values).where(eq(s.serviceCalls.id, callId)).returning();
        if (!u) throw notFound('Service call');
        previousUsers = (await tx.select({ id: s.serviceCallUsers.userId }).from(s.serviceCallUsers).where(eq(s.serviceCallUsers.serviceCallId, callId))).map((x) => x.id);
        await tx.delete(s.serviceCallUsers).where(eq(s.serviceCallUsers.serviceCallId, callId));
        await tx.delete(s.serviceCallTickets).where(eq(s.serviceCallTickets.serviceCallId, callId));
      } else {
        const [c] = await tx.insert(s.serviceCalls).values({ ...values, createdById: actorId }).returning();
        callId = c!.id;
      }
      if (input.userIds.length) await tx.insert(s.serviceCallUsers).values(input.userIds.map((userId) => ({ serviceCallId: callId!, userId })));
      if (input.ticketIds.length) await tx.insert(s.serviceCallTickets).values(input.ticketIds.map((ticketId) => ({ serviceCallId: callId!, ticketId })));
      const added = input.userIds.filter((u) => !previousUsers.includes(u));
      await notify(tx, added, { type: 'service_call', title: `Scheduled: ${input.title}`, body: startAt.toISOString(), link: '/calendar', entityType: 'service_call', entityId: callId }, actorId);
      return callId!;
    });
  };

  app.post('/service-calls', { config: { perm: 'tickets.write' } }, async (req, reply) => {
    const id = await save(null, req.body, currentUser(req).id);
    await audit(app.db, req, { action: 'create', entityType: 'service_call', entityId: id });
    return reply.status(201).send((await loadCalls(app.db, eq(s.serviceCalls.id, id)))[0]);
  });
  app.put('/service-calls/:id', { config: { perm: 'tickets.write' } }, async (req) => {
    const id = await save(idOf(req), req.body, currentUser(req).id);
    await audit(app.db, req, { action: 'update', entityType: 'service_call', entityId: id });
    return (await loadCalls(app.db, eq(s.serviceCalls.id, id)))[0];
  });
  app.delete('/service-calls/:id', { config: { perm: 'tickets.write', forceDelete: { table: 'service_calls' } } }, async (req) => {
    const id = idOf(req);
    await app.db.delete(s.serviceCalls).where(eq(s.serviceCalls.id, id));
    await audit(app.db, req, { action: 'delete', entityType: 'service_call', entityId: id });
    return { ok: true };
  });

  /** Calendar feed: service calls, ticket due dates and project task due dates for a range. */
  app.get('/calendar', async (req) => {
    const q = req.query as Record<string, string>;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86400_000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 35 * 86400_000);
    const me = currentUser(req);
    const userId = q.userId === 'all' ? null : intParam(q.userId) ?? me.id;
    const calls = await loadCalls(
      app.db,
      and(
        lt(s.serviceCalls.startAt, to),
        gte(s.serviceCalls.endAt, from),
        userId ? sql`exists (select 1 from service_call_users x where x.service_call_id = ${s.serviceCalls.id} and x.user_id = ${userId})` : undefined,
      ),
    );
    const due = await app.db.execute<{ id: number; ticketNumber: string; title: string; at: string; priorityColor: string }>(sql`
      select t.id, t.ticket_number as "ticketNumber", t.title, coalesce(t.due_at, t.resolution_due_at) as at, p.color as "priorityColor"
      from tickets t join ticket_statuses st on st.id = t.status_id join ticket_priorities p on p.id = t.priority_id
      where st.category not in ('resolved','closed') and coalesce(t.due_at, t.resolution_due_at) between ${from} and ${to}
        ${userId ? sql`and t.assigned_user_id = ${userId}` : sql``}
      order by at limit 300`);
    const tasks = await app.db.execute<{ id: number; projectId: number; title: string; dueDate: string; projectName: string }>(sql`
      select pt.id, pt.project_id as "projectId", pt.title, pt.due_date::text as "dueDate", p.name as "projectName"
      from project_tasks pt join projects p on p.id = pt.project_id
      where pt.status <> 'done' and pt.due_date between ${from.toISOString().slice(0, 10)}::date and ${to.toISOString().slice(0, 10)}::date
        ${userId ? sql`and pt.assigned_user_id = ${userId}` : sql``}
      limit 300`);
    return { serviceCalls: calls, ticketDue: due.rows, taskDue: tasks.rows };
  });
}

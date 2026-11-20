import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { timeApprovalSchema, timeEntryBaseSchema, timeEntrySchema, timerStartSchema } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { boolParam, countAll, idList, intParam, paginated, parseList, searchAny, whereAll } from '../../lib/query.js';
import { can, currentUser } from '../../lib/context.js';
import { getSystemSettings } from '../../lib/settings.js';
import { toCsv } from '../tickets/routes.js';
import { assertContractCompany, classifyTime, invoiceLock, resolveTimeContext, roundMinutes } from './service.js';
import { recomputeCoverage } from '../contracts/coverage.js';


const LOCKED = new Set(['approved', 'billed']);

const timerStopSchema = z.object({
  description: z.string().trim().min(1, 'Required').max(10000),
  workTypeId: z.coerce.number().int().positive().nullish(),
  billable: z.boolean().optional(),
  internalNotes: z.string().max(10000).nullish(),
});

export async function timeRoutes(app: FastifyInstance) {
  const list = async (req: FastifyRequest, limit?: number) => {
    const me = currentUser(req);
    const q = parseList(req.query);
    const viewAll = can(req, 'time.read_all');
    let userIds = q.userId === 'me' ? [me.id] : idList(q.userId);
    if (!viewAll) userIds = [me.id];
    const where = whereAll(
      userIds.length ? inArray(s.timeEntries.userId, userIds) : undefined,
      intParam(q.ticketId) ? eq(s.timeEntries.ticketId, intParam(q.ticketId)!) : undefined,
      intParam(q.projectId) ? eq(s.timeEntries.projectId, intParam(q.projectId)!) : undefined,
      intParam(q.projectTaskId) ? eq(s.timeEntries.projectTaskId, intParam(q.projectTaskId)!) : undefined,
      intParam(q.companyId) ? eq(s.timeEntries.companyId, intParam(q.companyId)!) : undefined,
      intParam(q.contractId) ? eq(s.timeEntries.contractId, intParam(q.contractId)!) : undefined,
      intParam(q.workTypeId) ? eq(s.timeEntries.workTypeId, intParam(q.workTypeId)!) : undefined,
      q.status ? inArray(s.timeEntries.status, String(q.status).split(',')) : undefined,
      boolParam(q.billable) !== undefined ? eq(s.timeEntries.billable, boolParam(q.billable)!) : undefined,
      q.from ? gte(s.timeEntries.startedAt, new Date(String(q.from))) : undefined,
      q.to ? lt(s.timeEntries.startedAt, new Date(String(q.to))) : undefined,
      searchAny(q.q, [s.timeEntries.description, s.tickets.ticketNumber, s.tickets.title, s.companies.name]),
    );
    const pageSize = limit ?? q.pageSize;
    const rows = await app.db
      .select({
        entry: s.timeEntries,
        userName: sql<string>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        companyName: s.companies.name,
        ticketNumber: s.tickets.ticketNumber,
        ticketTitle: s.tickets.title,
        taskTitle: s.projectTasks.title,
        projectName: s.projects.name,
        workTypeName: s.workTypes.name,
        contractName: s.contracts.name,
      })
      .from(s.timeEntries)
      .innerJoin(s.users, eq(s.users.id, s.timeEntries.userId))
      .innerJoin(s.companies, eq(s.companies.id, s.timeEntries.companyId))
      .leftJoin(s.tickets, eq(s.tickets.id, s.timeEntries.ticketId))
      .leftJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
      .leftJoin(s.projects, eq(s.projects.id, s.timeEntries.projectId))
      .leftJoin(s.workTypes, eq(s.workTypes.id, s.timeEntries.workTypeId))
      .leftJoin(s.contracts, eq(s.contracts.id, s.timeEntries.contractId))
      .where(where)
      .orderBy(desc(s.timeEntries.startedAt), desc(s.timeEntries.id))
      .limit(pageSize)
      .offset((q.page - 1) * pageSize);
    const [totals] = (await app.db
      .select({
        n: countAll,
        minutes: sql<number>`coalesce(sum(${s.timeEntries.durationMinutes}),0)::int`,
        billableMinutes: sql<number>`coalesce(sum(${s.timeEntries.durationMinutes}) filter (where ${s.timeEntries.billable}),0)::int`,
        coveredMinutes: sql<number>`coalesce(sum(${s.timeEntries.durationMinutes}) filter (where ${s.timeEntries.contractCovered}),0)::int`,
      })
      .from(s.timeEntries)
      .innerJoin(s.companies, eq(s.companies.id, s.timeEntries.companyId))
      .leftJoin(s.tickets, eq(s.tickets.id, s.timeEntries.ticketId))
      .where(where)) as [{ n: number; minutes: number; billableMinutes: number; coveredMinutes: number }];
    return {
      ...paginated(
        rows.map((r) => ({ ...r.entry, ...r, entry: undefined })),
        totals.n,
        q,
      ),
      totals: { minutes: totals.minutes, billableMinutes: totals.billableMinutes, coveredMinutes: totals.coveredMinutes },
    };
  };

  app.get('/time-entries', { config: { perm: 'time.read' } }, async (req) => list(req));

  app.get('/time-entries/export.csv', { config: { perm: 'time.read' } }, async (req, reply) => {
    req.query = { ...(req.query as object), page: 1, pageSize: 500 };
    const result = await list(req, 20000);
    const csv = toCsv(
      result.data.map((r: Record<string, unknown>) => ({ ...r, hours: ((r.durationMinutes as number) / 60).toFixed(2) })),
      [
        ['startedAt', 'Date'],
        ['userName', 'Resource'],
        ['companyName', 'Company'],
        ['ticketNumber', 'Ticket'],
        ['projectName', 'Project'],
        ['taskTitle', 'Task'],
        ['workTypeName', 'Work type'],
        ['hours', 'Hours'],
        ['billable', 'Billable'],
        ['contractCovered', 'Contract covered'],
        ['hourlyRate', 'Rate'],
        ['status', 'Status'],
        ['description', 'Description'],
      ],
    );
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="time-entries.csv"').send(csv);
  });

  app.post('/time-entries', { config: { perm: 'time.write' } }, async (req, reply) => {
    const me = currentUser(req);
    const input = timeEntrySchema.parse(req.body);
    const userId = input.userId ?? me.id;
    if (userId !== me.id && !can(req, 'time.write_all')) throw forbidden('You can only log your own time');
    const row = await app.db.transaction(async (tx) => {
      const ctx = await resolveTimeContext(tx, input.ticketId, input.projectTaskId);
      const contractId = input.contractId ?? ctx.contractId;
      if (input.contractId) await assertContractCompany(tx, input.contractId, ctx.companyId);
      const settings = await getSystemSettings(tx);
      const duration = roundMinutes(input.durationMinutes, settings.timeRoundingMinutes);
      const startedAt = new Date(input.startedAt);
      if (Number.isNaN(startedAt.getTime())) throw badRequest('Invalid start time', { fields: { startedAt: 'Invalid date/time' } });
      if (startedAt.getTime() > Date.now() + 24 * 3600_000) throw badRequest('Time cannot be logged more than a day in the future', { fields: { startedAt: 'Too far in the future' } });
      const cls = await classifyTime(tx, contractId, input.workTypeId, (req.body as { billable?: boolean }).billable, { startedAt, durationMinutes: duration });
      const [r] = await tx
        .insert(s.timeEntries)
        .values({
          userId,
          ticketId: input.ticketId,
          projectTaskId: input.projectTaskId,
          companyId: ctx.companyId,
          projectId: ctx.projectId,
          contractId,
          workTypeId: input.workTypeId,
          startedAt,
          endedAt: input.endedAt ? new Date(input.endedAt) : new Date(startedAt.getTime() + duration * 60_000),
          durationMinutes: duration,
          description: input.description,
          internalNotes: input.internalNotes,
          status: settings.requireTimeApproval ? 'submitted' : 'approved',
          ...cls,
        })
        .returning();
      if (input.ticketId) {
        await tx.insert(s.ticketEvents).values({ ticketId: input.ticketId, userId: me.id, type: 'time_added', data: { minutes: duration, entryId: r!.id } });
        await tx.update(s.tickets).set({ lastActivityAt: new Date() }).where(eq(s.tickets.id, input.ticketId));
      }
      await audit(tx, req, { action: 'create', entityType: 'time_entry', entityId: r!.id, summary: `${duration} min` });
      await recomputeCoverage(tx, [contractId]);
      const [fresh] = await tx.select().from(s.timeEntries).where(eq(s.timeEntries.id, r!.id));
      return fresh!;
    });
    return reply.status(201).send(row);
  });

  app.patch('/time-entries/:id', { config: { perm: 'time.write' } }, async (req) => {
    const id = idOf(req);
    const me = currentUser(req);
    return app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s.timeEntries).where(eq(s.timeEntries.id, id));
      if (!before) throw notFound('Time entry');
      if (before.userId !== me.id && !can(req, 'time.write_all')) throw forbidden();
      if (before.status === 'billed') throw badRequest('Billed time entries cannot be changed');
      if (before.invoiceId) throw await invoiceLock(tx, before.invoiceId, 'time entry');
      const settings = await getSystemSettings(tx);
      if (LOCKED.has(before.status) && !can(req, 'time.approve') && before.userId === me.id && settings.requireTimeApproval) {
        throw badRequest('Approved time entries can only be changed by an approver');
      }
      const body = req.body as Record<string, unknown>;
      const input = timeEntryBaseSchema.partial().parse(body);
      const data: Partial<typeof before> = {};
      if ('description' in body) data.description = input.description!;
      if ('internalNotes' in body) data.internalNotes = input.internalNotes ?? null;
      if ('durationMinutes' in body) data.durationMinutes = roundMinutes(input.durationMinutes!, settings.timeRoundingMinutes);
      if ('startedAt' in body) {
        data.startedAt = new Date(input.startedAt!);
        if (Number.isNaN(data.startedAt.getTime())) throw badRequest('Invalid start time', { fields: { startedAt: 'Invalid date/time' } });
      }
      if ('workTypeId' in body) data.workTypeId = input.workTypeId ?? null;
      if ('contractId' in body) {
        data.contractId = input.contractId ?? null;
        await assertContractCompany(tx, data.contractId, before.companyId);
      }
      if (['workTypeId', 'billable', 'contractId', 'startedAt', 'durationMinutes'].some((k) => k in body)) {
        const cls = await classifyTime(
          tx,
          'contractId' in data ? data.contractId! : before.contractId,
          'workTypeId' in data ? data.workTypeId! : before.workTypeId,
          'billable' in body ? input.billable : before.billable,
          { startedAt: data.startedAt ?? before.startedAt, durationMinutes: data.durationMinutes ?? before.durationMinutes },
        );
        Object.assign(data, cls);
      }
      if (data.startedAt || data.durationMinutes) {
        const start = data.startedAt ?? before.startedAt;
        data.endedAt = new Date(start.getTime() + (data.durationMinutes ?? before.durationMinutes) * 60_000);
      }
      await tx.update(s.timeEntries).set(data).where(eq(s.timeEntries.id, id));
      await recomputeCoverage(tx, [before.contractId, data.contractId]);
      const [row] = await tx.select().from(s.timeEntries).where(eq(s.timeEntries.id, id));
      await audit(tx, req, { action: 'update', entityType: 'time_entry', entityId: id, changes: diff(before, data) });
      return row;
    });
  });

  app.delete('/time-entries/:id', { config: { perm: 'time.write' } }, async (req) => {
    const id = idOf(req);
    const me = currentUser(req);
    const [before] = await app.db.select().from(s.timeEntries).where(eq(s.timeEntries.id, id));
    if (!before) throw notFound('Time entry');
    if (before.userId !== me.id && !can(req, 'time.write_all')) throw forbidden();
    if (before.status === 'billed') throw badRequest('Billed time entries cannot be deleted');
    if (before.invoiceId) throw await invoiceLock(app.db, before.invoiceId, 'time entry');
    await app.db.transaction(async (tx) => {
      await tx.delete(s.timeEntries).where(eq(s.timeEntries.id, id));
      await recomputeCoverage(tx, [before.contractId]);
      await audit(tx, req, { action: 'delete', entityType: 'time_entry', entityId: id, summary: `${before.durationMinutes} min: ${before.description.slice(0, 80)}` });
    });
    return { ok: true };
  });

  app.post('/time-entries/approve', { config: { perm: 'time.approve' } }, async (req) => {
    const input = timeApprovalSchema.parse(req.body);
    const me = currentUser(req);
    return app.db.transaction(async (tx) => {
      const [onInvoice] = await tx
        .select({ invoiceId: s.timeEntries.invoiceId })
        .from(s.timeEntries)
        .where(and(inArray(s.timeEntries.id, input.ids), sql`${s.timeEntries.invoiceId} is not null`, sql`${s.timeEntries.status} <> ${input.status}`))
        .limit(1);
      if (onInvoice?.invoiceId) throw await invoiceLock(tx, onInvoice.invoiceId, 'time entry');
      const rows = await tx
        .update(s.timeEntries)
        .set({ status: input.status, approvedById: me.id, approvedAt: new Date() })
        .where(and(inArray(s.timeEntries.id, input.ids), inArray(s.timeEntries.status, ['submitted', 'draft', 'rejected', 'approved'])))
        .returning({ id: s.timeEntries.id, contractId: s.timeEntries.contractId });
      await recomputeCoverage(tx, rows.map((r) => r.contractId));
      await audit(tx, req, { action: 'update', entityType: 'time_entry', summary: `${input.status} ${rows.length} entries`, changes: { ids: input.ids } });
      return { updated: rows.length };
    });
  });

  /** Daily totals for a week, for the timesheet view. */
  app.get('/time-entries/week', { config: { perm: 'time.read' } }, async (req) => {
    const me = currentUser(req);
    const q = req.query as { start?: string; userId?: string };
    const userId = q.userId && can(req, 'time.read_all') ? Number(q.userId) : me.id;
    const start = q.start ? new Date(q.start) : new Date();
    const rows = await app.db.execute<{ day: string; minutes: number; billable: number }>(sql`
      select to_char(started_at, 'YYYY-MM-DD') as day, sum(duration_minutes)::int as minutes,
             coalesce(sum(duration_minutes) filter (where billable), 0)::int as billable
      from time_entries where user_id = ${userId} and started_at >= ${start} and started_at < ${new Date(start.getTime() + 7 * 86400_000)}
      group by 1 order by 1`);
    return { data: rows.rows };
  });

  /* ---------------------------------------------------------------- timer */

  app.get('/timer', { config: { perm: 'time.write' } }, async (req) => {
    const me = currentUser(req);
    const [row] = await app.db
      .select({ timer: s.activeTimers, ticketNumber: s.tickets.ticketNumber, ticketTitle: s.tickets.title, taskTitle: s.projectTasks.title })
      .from(s.activeTimers)
      .leftJoin(s.tickets, eq(s.tickets.id, s.activeTimers.ticketId))
      .leftJoin(s.projectTasks, eq(s.projectTasks.id, s.activeTimers.projectTaskId))
      .where(eq(s.activeTimers.userId, me.id));
    return row ? { ...row.timer, ticketNumber: row.ticketNumber, ticketTitle: row.ticketTitle, taskTitle: row.taskTitle } : null;
  });

  app.post('/timer/start', { config: { perm: 'time.write' } }, async (req) => {
    const me = currentUser(req);
    const input = timerStartSchema.parse(req.body);
    if (!input.ticketId && !input.projectTaskId) throw badRequest('Start the timer on a ticket or a project task');
    await resolveTimeContext(app.db, input.ticketId, input.projectTaskId);
    const [existing] = await app.db.select().from(s.activeTimers).where(eq(s.activeTimers.userId, me.id));
    if (existing) throw badRequest('A timer is already running. Stop it before starting a new one.');
    const [row] = await app.db.insert(s.activeTimers).values({ userId: me.id, ...input }).returning();
    return row;
  });

  /** Stops the running timer and converts it into a time entry. */
  app.post('/timer/stop', { config: { perm: 'time.write' } }, async (req, reply) => {
    const me = currentUser(req);
    const input = timerStopSchema.parse(req.body);
    const [timer] = await app.db.select().from(s.activeTimers).where(eq(s.activeTimers.userId, me.id));
    if (!timer) throw badRequest('No timer is running');
    const elapsed = Math.max(1, Math.round((Date.now() - timer.startedAt.getTime()) / 60_000));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/time-entries',
      headers: { cookie: req.headers.cookie ?? '', 'x-csrf-token': req.csrfToken ?? '' },
      payload: {
        ticketId: timer.ticketId,
        projectTaskId: timer.projectTaskId,
        startedAt: timer.startedAt.toISOString(),
        durationMinutes: Math.min(elapsed, 24 * 60),
        description: input.description,
        workTypeId: input.workTypeId ?? null,
        internalNotes: input.internalNotes ?? null,
        ...(input.billable !== undefined ? { billable: input.billable } : {}),
      },
    });
    if (res.statusCode !== 201) return reply.status(res.statusCode).send(res.json());
    await app.db.delete(s.activeTimers).where(eq(s.activeTimers.id, timer.id));
    return reply.status(201).send(res.json());
  });

  app.delete('/timer', { config: { perm: 'time.write' } }, async (req) => {
    await app.db.delete(s.activeTimers).where(eq(s.activeTimers.userId, currentUser(req).id));
    return { ok: true };
  });
}

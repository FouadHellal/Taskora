import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { formatNumber, milestoneSchema, projectSchema, projectTaskSchema } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, notFound, inUse } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { countAll, intParam, nextSequence, orderFrom, paginated, parseList, searchAny, whereAll } from '../../lib/query.js';
import { validateCustomFields } from '../../lib/custom-fields.js';
import { currentUser } from '../../lib/context.js';
import { getSystemSettings } from '../../lib/settings.js';
import { notify } from '../notifications/service.js';

export async function projectRoutes(app: FastifyInstance) {
  const progress = sql<number>`(select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where pt.status = 'done') / count(*)) end::int from project_tasks pt where pt.project_id = ${s.projects.id})`;
  const actualMinutes = sql<number>`(select coalesce(sum(te.duration_minutes),0)::int from time_entries te where te.project_id = ${s.projects.id})`;

  app.get('/projects', { config: { perm: 'projects.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(
      intParam(q.companyId) ? eq(s.projects.companyId, intParam(q.companyId)!) : undefined,
      intParam(q.managerId) ? eq(s.projects.managerId, intParam(q.managerId)!) : undefined,
      q.status ? inArray(s.projects.status, String(q.status).split(',')) : undefined,
      searchAny(q.q, [s.projects.name, s.projects.projectNumber, s.companies.name]),
    );
    const rows = await app.db
      .select({
        id: s.projects.id,
        projectNumber: s.projects.projectNumber,
        name: s.projects.name,
        status: s.projects.status,
        companyId: s.projects.companyId,
        companyName: s.companies.name,
        managerName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        startDate: s.projects.startDate,
        endDate: s.projects.endDate,
        estimatedHours: s.projects.estimatedHours,
        budget: s.projects.budget,
        progress,
        actualMinutes,
        openTasks: sql<number>`(select count(*)::int from project_tasks pt where pt.project_id = ${s.projects.id} and pt.status <> 'done')`,
      })
      .from(s.projects)
      .innerJoin(s.companies, eq(s.companies.id, s.projects.companyId))
      .leftJoin(s.users, eq(s.users.id, s.projects.managerId))
      .where(where)
      .orderBy(...orderFrom(q.sort, q.order, { name: s.projects.name, company: s.companies.name, endDate: s.projects.endDate, status: s.projects.status }, s.projects.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.projects).innerJoin(s.companies, eq(s.companies.id, s.projects.companyId)).where(where)) as [
      { n: number },
    ];
    return paginated(rows, n, q);
  });

  app.get('/projects/:id', { config: { perm: 'projects.read' } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db
      .select({
        project: s.projects,
        companyName: s.companies.name,
        contractName: s.contracts.name,
        managerName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        progress,
        actualMinutes,
      })
      .from(s.projects)
      .innerJoin(s.companies, eq(s.companies.id, s.projects.companyId))
      .leftJoin(s.contracts, eq(s.contracts.id, s.projects.contractId))
      .leftJoin(s.users, eq(s.users.id, s.projects.managerId))
      .where(eq(s.projects.id, id));
    if (!row) throw notFound('Project');
    const milestones = await app.db.select().from(s.projectMilestones).where(eq(s.projectMilestones.projectId, id)).orderBy(asc(s.projectMilestones.dueDate), asc(s.projectMilestones.sortOrder));
    const tasks = await app.db
      .select({
        task: s.projectTasks,
        assigneeName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        actualMinutes: sql<number>`(select coalesce(sum(te.duration_minutes),0)::int from time_entries te where te.project_task_id = ${s.projectTasks.id})`,
      })
      .from(s.projectTasks)
      .leftJoin(s.users, eq(s.users.id, s.projectTasks.assignedUserId))
      .where(eq(s.projectTasks.projectId, id))
      .orderBy(asc(s.projectTasks.sortOrder), asc(s.projectTasks.id));
    return {
      ...row.project,
      companyName: row.companyName,
      contractName: row.contractName,
      managerName: row.managerName,
      progress: row.progress,
      actualMinutes: row.actualMinutes,
      milestones,
      tasks: tasks.map((t) => ({ ...t.task, assigneeName: t.assigneeName, actualMinutes: t.actualMinutes })),
    };
  });

  app.post('/projects', { config: { perm: 'projects.write' } }, async (req, reply) => {
    const input = projectSchema.parse(req.body);
    const row = await app.db.transaction(async (tx) => {
      const settings = await getSystemSettings(tx);
      const customFields = await validateCustomFields(tx, 'project', input.customFields);
      if (input.contractId) {
        const [c] = await tx.select({ companyId: s.contracts.companyId }).from(s.contracts).where(eq(s.contracts.id, input.contractId));
        if (!c || c.companyId !== input.companyId) throw badRequest('The contract belongs to another company');
      }
      const [r] = await tx
        .insert(s.projects)
        .values({ ...input, customFields, projectNumber: formatNumber(settings.projectPrefix, await nextSequence(tx, 'project')) })
        .returning();
      await audit(tx, req, { action: 'create', entityType: 'project', entityId: r!.id, summary: `${r!.projectNumber} ${r!.name}` });
      return r!;
    });
    return reply.status(201).send(row);
  });

  app.patch('/projects/:id', { config: { perm: 'projects.write' } }, async (req) => {
    const id = idOf(req);
    const input = projectSchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    return app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s.projects).where(eq(s.projects.id, id));
      if (!before) throw notFound('Project');
      const data = Object.fromEntries(Object.entries(input).filter(([k]) => k in body && k !== 'companyId')) as Partial<typeof before>;
      if ('customFields' in body) data.customFields = await validateCustomFields(tx, 'project', input.customFields, before.customFields);
      if (data.status === 'completed' && before.status !== 'completed') data.completedAt = new Date();
      if (data.status && data.status !== 'completed') data.completedAt = null;
      const [row] = await tx.update(s.projects).set(data).where(eq(s.projects.id, id)).returning();
      await audit(tx, req, { action: 'update', entityType: 'project', entityId: id, changes: diff(before, data) });
      return row;
    });
  });

  app.delete('/projects/:id', { config: { perm: 'projects.write', forceDelete: { table: 'projects' } } }, async (req) => {
    const id = idOf(req);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.timeEntries).where(eq(s.timeEntries.projectId, id))) as [{ n: number }];
    if (n > 0) throw inUse('Time has been logged on this project. Cancel it instead of deleting it.');
    const [row] = await app.db.delete(s.projects).where(eq(s.projects.id, id)).returning();
    if (!row) throw notFound('Project');
    await audit(app.db, req, { action: 'delete', entityType: 'project', entityId: id, summary: row.name });
    return { ok: true };
  });

  /* ---- milestones ---- */

  /** Milestones across projects (upcoming / overdue overview) with task progress. */
  app.get('/project-milestones', { config: { perm: 'projects.read' } }, async (req) => {
    const q = parseList(req.query);
    const status = q.status === 'complete' || q.status === 'all' ? String(q.status) : 'open';
    const where = whereAll(
      status === 'open' ? eq(s.projectMilestones.isComplete, false) : undefined,
      status === 'complete' ? eq(s.projectMilestones.isComplete, true) : undefined,
      intParam(q.projectId) ? eq(s.projectMilestones.projectId, intParam(q.projectId)!) : undefined,
      intParam(q.companyId) ? eq(s.projects.companyId, intParam(q.companyId)!) : undefined,
      q.overdue === 'true' ? sql`${s.projectMilestones.dueDate} < current_date and ${s.projectMilestones.isComplete} = false` : undefined,
      searchAny(q.q, [s.projectMilestones.name, s.projects.name, s.projects.projectNumber, s.companies.name]),
    );
    const sortable = { dueDate: s.projectMilestones.dueDate, name: s.projectMilestones.name, project: s.projects.name, company: s.companies.name };
    const sortCol = q.sort && q.sort in sortable ? sortable[q.sort as keyof typeof sortable] : s.projectMilestones.dueDate;
    const dir = q.sort && q.sort in sortable ? q.order : 'asc';
    const rows = await app.db
      .select({
        id: s.projectMilestones.id,
        projectId: s.projectMilestones.projectId,
        name: s.projectMilestones.name,
        description: s.projectMilestones.description,
        dueDate: s.projectMilestones.dueDate,
        isComplete: s.projectMilestones.isComplete,
        completedAt: s.projectMilestones.completedAt,
        projectName: s.projects.name,
        projectNumber: s.projects.projectNumber,
        projectStatus: s.projects.status,
        companyId: s.projects.companyId,
        companyName: s.companies.name,
        taskCount: sql<number>`(select count(*)::int from project_tasks pt where pt.milestone_id = ${s.projectMilestones.id})`,
        doneTaskCount: sql<number>`(select count(*)::int from project_tasks pt where pt.milestone_id = ${s.projectMilestones.id} and pt.status = 'done')`,
      })
      .from(s.projectMilestones)
      .innerJoin(s.projects, eq(s.projects.id, s.projectMilestones.projectId))
      .innerJoin(s.companies, eq(s.companies.id, s.projects.companyId))
      .where(where)
      .orderBy(sql`${sortCol} ${dir === 'desc' ? sql`desc` : sql`asc`} nulls last`, asc(s.projectMilestones.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db
      .select({ n: countAll })
      .from(s.projectMilestones)
      .innerJoin(s.projects, eq(s.projects.id, s.projectMilestones.projectId))
      .innerJoin(s.companies, eq(s.companies.id, s.projects.companyId))
      .where(where)) as [{ n: number }];
    return paginated(rows, n, q);
  });

  app.post('/projects/:id/milestones', { config: { perm: 'projects.write' } }, async (req, reply) => {
    const input = milestoneSchema.parse(req.body);
    const [row] = await app.db
      .insert(s.projectMilestones)
      .values({ ...input, projectId: idOf(req), completedAt: input.isComplete ? new Date() : null })
      .returning();
    return reply.status(201).send(row);
  });
  app.patch('/projects/:id/milestones/:milestoneId', { config: { perm: 'projects.write' } }, async (req) => {
    const input = milestoneSchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = Object.fromEntries(Object.entries(input).filter(([k]) => k in body));
    if ('isComplete' in data) data.completedAt = data.isComplete ? new Date() : null;
    const [row] = await app.db
      .update(s.projectMilestones)
      .set(data)
      .where(and(eq(s.projectMilestones.id, idOf(req, 'milestoneId')), eq(s.projectMilestones.projectId, idOf(req))))
      .returning();
    if (!row) throw notFound('Milestone');
    return row;
  });
  app.delete('/projects/:id/milestones/:milestoneId', { config: { perm: 'projects.write', forceDelete: { table: 'project_milestones', param: 'milestoneId' } } }, async (req) => {
    await app.db.delete(s.projectMilestones).where(and(eq(s.projectMilestones.id, idOf(req, 'milestoneId')), eq(s.projectMilestones.projectId, idOf(req))));
    return { ok: true };
  });

  /* ---- tasks ---- */

  app.get('/project-tasks', { config: { perm: 'projects.read' } }, async (req) => {
    const q = parseList(req.query);
    const me = currentUser(req);
    const assigned = q.assignedUserId === 'me' ? me.id : intParam(q.assignedUserId);
    const where = whereAll(
      assigned ? eq(s.projectTasks.assignedUserId, assigned) : undefined,
      intParam(q.projectId) ? eq(s.projectTasks.projectId, intParam(q.projectId)!) : undefined,
      q.status ? inArray(s.projectTasks.status, String(q.status).split(',')) : undefined,
      q.open === 'true' ? sql`${s.projectTasks.status} <> 'done'` : undefined,
      searchAny(q.q, [s.projectTasks.title, s.projects.name]),
    );
    const rows = await app.db
      .select({
        task: s.projectTasks,
        projectName: s.projects.name,
        projectNumber: s.projects.projectNumber,
        companyName: s.companies.name,
        assigneeName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        milestoneName: s.projectMilestones.name,
      })
      .from(s.projectTasks)
      .innerJoin(s.projects, eq(s.projects.id, s.projectTasks.projectId))
      .innerJoin(s.companies, eq(s.companies.id, s.projects.companyId))
      .leftJoin(s.users, eq(s.users.id, s.projectTasks.assignedUserId))
      .leftJoin(s.projectMilestones, eq(s.projectMilestones.id, s.projectTasks.milestoneId))
      .where(where)
      .orderBy(sql`${s.projectTasks.dueDate} asc nulls last`, asc(s.projectTasks.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.projectTasks).innerJoin(s.projects, eq(s.projects.id, s.projectTasks.projectId)).where(where)) as [
      { n: number },
    ];
    return paginated(
      rows.map((r) => ({ ...r.task, projectName: r.projectName, projectNumber: r.projectNumber, companyName: r.companyName, assigneeName: r.assigneeName, milestoneName: r.milestoneName })),
      n,
      q,
    );
  });

  app.post('/projects/:id/tasks', { config: { perm: 'projects.write' } }, async (req, reply) => {
    const projectId = idOf(req);
    const input = projectTaskSchema.parse(req.body);
    const [project] = await app.db.select({ id: s.projects.id, name: s.projects.name }).from(s.projects).where(eq(s.projects.id, projectId));
    if (!project) throw notFound('Project');
    const [{ max }] = (await app.db
      .select({ max: sql<number>`coalesce(max(${s.projectTasks.sortOrder}),0)::int` })
      .from(s.projectTasks)
      .where(eq(s.projectTasks.projectId, projectId))) as [{ max: number }];
    const [row] = await app.db
      .insert(s.projectTasks)
      .values({ ...input, projectId, sortOrder: max + 10, completedAt: input.status === 'done' ? new Date() : null })
      .returning();
    if (row!.assignedUserId) {
      await notify(app.db, [row!.assignedUserId], { type: 'task.assigned', title: `Task assigned: ${row!.title}`, body: project.name, link: `/projects/${projectId}`, entityType: 'project', entityId: projectId }, currentUser(req).id);
    }
    return reply.status(201).send(row);
  });

  app.patch('/project-tasks/:taskId', { config: { perm: 'projects.write' } }, async (req) => {
    const taskId = idOf(req, 'taskId');
    const input = projectTaskSchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    const [before] = await app.db.select().from(s.projectTasks).where(eq(s.projectTasks.id, taskId));
    if (!before) throw notFound('Task');
    const data: Record<string, unknown> = Object.fromEntries(Object.entries(input).filter(([k]) => k in body));
    if ('sortOrder' in body) data.sortOrder = Number(body.sortOrder) || 0;
    if (data.status === 'done' && before.status !== 'done') data.completedAt = new Date();
    if (data.status && data.status !== 'done') data.completedAt = null;
    const [row] = await app.db.update(s.projectTasks).set(data).where(eq(s.projectTasks.id, taskId)).returning();
    if (data.assignedUserId && data.assignedUserId !== before.assignedUserId) {
      await notify(app.db, [Number(data.assignedUserId)], { type: 'task.assigned', title: `Task assigned: ${row!.title}`, link: `/projects/${row!.projectId}`, entityType: 'project', entityId: row!.projectId }, currentUser(req).id);
    }
    return row;
  });

  app.delete('/project-tasks/:taskId', { config: { perm: 'projects.write', forceDelete: { table: 'project_tasks', param: 'taskId' } } }, async (req) => {
    const taskId = idOf(req, 'taskId');
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.timeEntries).where(eq(s.timeEntries.projectTaskId, taskId))) as [{ n: number }];
    if (n > 0) throw badRequest('Time has been logged on this task');
    await app.db.delete(s.projectTasks).where(eq(s.projectTasks.id, taskId));
    return { ok: true };
  });
}

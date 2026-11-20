import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  savedViewSchema,
  ticketBulkSchema,
  ticketNoteSchema,
  ticketRelationSchema,
  ticketSchema,
  ticketUpdateSchema,
  TICKET_EXPORT_COLUMNS,
} from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { countAll, idList, intParam, likeTerm, orderFrom, paginated, parseList, whereAll } from '../../lib/query.js';
import { can, currentUser } from '../../lib/context.js';
import { slaEventState } from '../../lib/business-time.js';
import { getSystemSettings } from '../../lib/settings.js';
import { addTicketNote, createTicket, getTicketRow, updateTicket, type TicketRow } from './service.js';
import { runTicketRules } from '../automation/engine.js';
import { emitTicketEvent } from '../../lib/webhooks.js';
import { enqueue } from '../../jobs/queue.js';

const assignee = alias(s.users, 'assignee');
const fullName = (u: { firstName: AnyColumn; lastName: AnyColumn }) => sql<string | null>`${u.firstName} || ' ' || ${u.lastName}`;

export function slaSummary(t: Pick<TicketRow, 'firstResponseDueAt' | 'firstResponseAt' | 'firstResponseBreached' | 'resolutionDueAt' | 'resolvedAt' | 'resolutionBreached' | 'slaPausedAt'>, warningMinutes: number, now = new Date()) {
  const firstResponse = slaEventState({
    dueAt: t.firstResponseDueAt,
    doneAt: t.firstResponseAt,
    breached: t.firstResponseBreached,
    paused: false,
    now,
    warningMinutes,
  });
  const resolution = slaEventState({
    dueAt: t.resolutionDueAt,
    doneAt: t.resolvedAt,
    breached: t.resolutionBreached,
    paused: !!t.slaPausedAt,
    now,
    warningMinutes,
  });
  const order = ['breached', 'at_risk', 'paused', 'pending', 'met_late', 'met', 'none'];
  const overall = [firstResponse, resolution].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]!;
  return { firstResponse, resolution, overall };
}

/** Builds the WHERE clause shared by list, export and bulk selection. */
export function ticketFilters(req: FastifyRequest, q: Record<string, unknown>): SQL | undefined {
  const me = currentUser(req);
  const conds: (SQL | undefined)[] = [];
  const statusIds = idList(q.statusIds);
  if (statusIds.length) conds.push(inArray(s.tickets.statusId, statusIds));
  const cat = q.statusCategory ? String(q.statusCategory) : undefined;
  if (cat === 'open') conds.push(sql`${s.ticketStatuses.category} not in ('resolved','closed')`);
  else if (cat === 'done') conds.push(sql`${s.ticketStatuses.category} in ('resolved','closed')`);
  else if (cat && cat !== 'all') conds.push(inArray(s.ticketStatuses.category, cat.split(',')));
  const pr = idList(q.priorityIds);
  if (pr.length) conds.push(inArray(s.tickets.priorityId, pr));
  const qu = idList(q.queueIds);
  if (qu.length) conds.push(inArray(s.tickets.queueId, qu));
  if (q.assignedUserId === 'me') conds.push(eq(s.tickets.assignedUserId, me.id));
  else if (q.assignedUserId === 'none') conds.push(isNull(s.tickets.assignedUserId));
  else if (idList(q.assignedUserId).length) conds.push(inArray(s.tickets.assignedUserId, idList(q.assignedUserId)));
  if (q.watching === 'true') conds.push(sql`exists (select 1 from ticket_watchers w where w.ticket_id = ${s.tickets.id} and w.user_id = ${me.id})`);
  for (const [param, col] of [
    ['companyId', s.tickets.companyId],
    ['contactId', s.tickets.contactId],
    ['configurationItemId', s.tickets.configurationItemId],
    ['contractId', s.tickets.contractId],
    ['projectId', s.tickets.projectId],
    ['ticketTypeId', s.tickets.ticketTypeId],
    ['issueTypeId', s.tickets.issueTypeId],
    ['subIssueTypeId', s.tickets.subIssueTypeId],
    ['sourceId', s.tickets.sourceId],
    ['slaId', s.tickets.slaId],
  ] as const) {
    const ids = idList(q[param]);
    if (ids.length) conds.push(inArray(col, ids));
  }
  if (q.slaState === 'breached') conds.push(sql`(${s.tickets.firstResponseBreached} or ${s.tickets.resolutionBreached} or (${s.tickets.resolvedAt} is null and ${s.tickets.slaPausedAt} is null and ${s.tickets.resolutionDueAt} < now()) or (${s.tickets.firstResponseAt} is null and ${s.tickets.firstResponseDueAt} < now()))`);
  if (q.slaState === 'at_risk') {
    conds.push(sql`${s.tickets.resolvedAt} is null and ${s.tickets.slaPausedAt} is null and (
      (${s.tickets.firstResponseAt} is null and ${s.tickets.firstResponseDueAt} between now() and now() + interval '1 hour') or
      (${s.tickets.resolutionDueAt} between now() and now() + interval '1 hour'))`);
  }
  if (q.tag) conds.push(sql`${String(q.tag)} = any(${s.tickets.tags})`);
  if (q.createdFrom) conds.push(gte(s.tickets.createdAt, new Date(String(q.createdFrom))));
  if (q.createdTo) conds.push(lte(s.tickets.createdAt, new Date(String(q.createdTo))));
  if (q.q) {
    const term = likeTerm(String(q.q));
    conds.push(
      or(
        sql`${s.tickets.ticketNumber} ilike ${term}`,
        sql`${s.tickets.title} ilike ${term}`,
        sql`${s.tickets.description} ilike ${term}`,
        sql`${s.companies.name} ilike ${term}`,
      ),
    );
  }
  return whereAll(...conds);
}

export async function listTickets(app: FastifyInstance, req: FastifyRequest, query: Record<string, unknown>, limitOverride?: number) {
  const q = parseList(query);
  const where = ticketFilters(req, q);
  const sortable = {
    ticketNumber: s.tickets.id,
    title: s.tickets.title,
    company: s.companies.name,
    status: s.ticketStatuses.sortOrder,
    priority: s.ticketPriorities.level,
    assignee: assignee.firstName,
    queue: s.queues.name,
    createdAt: s.tickets.createdAt,
    updatedAt: s.tickets.updatedAt,
    lastActivityAt: s.tickets.lastActivityAt,
    dueAt: sql`coalesce(${s.tickets.dueAt}, ${s.tickets.resolutionDueAt})`,
  };
  const pageSize = limitOverride ?? q.pageSize;
  const rows = await app.db
    .select({
      id: s.tickets.id,
      ticketNumber: s.tickets.ticketNumber,
      title: s.tickets.title,
      companyId: s.tickets.companyId,
      companyName: s.companies.name,
      contactId: s.tickets.contactId,
      contactName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
      configurationItemId: s.tickets.configurationItemId,
      ciName: s.configurationItems.name,
      assignedUserId: s.tickets.assignedUserId,
      assigneeName: fullName(assignee),
      queueId: s.tickets.queueId,
      queueName: s.queues.name,
      statusId: s.tickets.statusId,
      statusName: s.ticketStatuses.name,
      statusColor: s.ticketStatuses.color,
      statusCategory: s.ticketStatuses.category,
      priorityId: s.tickets.priorityId,
      priorityName: s.ticketPriorities.name,
      priorityColor: s.ticketPriorities.color,
      priorityLevel: s.ticketPriorities.level,
      ticketTypeName: s.ticketTypes.name,
      issueTypeName: s.issueTypes.name,
      tags: s.tickets.tags,
      dueAt: s.tickets.dueAt,
      firstResponseDueAt: s.tickets.firstResponseDueAt,
      firstResponseAt: s.tickets.firstResponseAt,
      firstResponseBreached: s.tickets.firstResponseBreached,
      resolutionDueAt: s.tickets.resolutionDueAt,
      resolvedAt: s.tickets.resolvedAt,
      resolutionBreached: s.tickets.resolutionBreached,
      slaPausedAt: s.tickets.slaPausedAt,
      createdAt: s.tickets.createdAt,
      updatedAt: s.tickets.updatedAt,
      lastActivityAt: s.tickets.lastActivityAt,
      minutesWorked: sql<number>`(select coalesce(sum(duration_minutes),0)::int from time_entries te where te.ticket_id = ${s.tickets.id})`,
    })
    .from(s.tickets)
    .innerJoin(s.companies, eq(s.companies.id, s.tickets.companyId))
    .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
    .innerJoin(s.ticketPriorities, eq(s.ticketPriorities.id, s.tickets.priorityId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.tickets.contactId))
    .leftJoin(s.configurationItems, eq(s.configurationItems.id, s.tickets.configurationItemId))
    .leftJoin(assignee, eq(assignee.id, s.tickets.assignedUserId))
    .leftJoin(s.queues, eq(s.queues.id, s.tickets.queueId))
    .leftJoin(s.ticketTypes, eq(s.ticketTypes.id, s.tickets.ticketTypeId))
    .leftJoin(s.issueTypes, eq(s.issueTypes.id, s.tickets.issueTypeId))
    .where(where)
    .orderBy(...orderFrom(q.sort, q.order, sortable, s.tickets.createdAt), desc(s.tickets.id))
    .limit(pageSize)
    .offset((q.page - 1) * pageSize);
  const [{ n }] = (await app.db
    .select({ n: countAll })
    .from(s.tickets)
    .innerJoin(s.companies, eq(s.companies.id, s.tickets.companyId))
    .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
    .where(where)) as [{ n: number }];
  const { slaWarningMinutes } = await getSystemSettings(app.db);
  const now = new Date();
  return paginated(
    rows.map((r) => ({ ...r, sla: slaSummary(r, slaWarningMinutes, now) })),
    n,
    q,
  );
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const str = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n\r]/.test(str) || /^[=+\-@]/.test(str) ? `"${(/^[=+\-@]/.test(str) ? "'" : '') + str.replace(/"/g, '""')}"` : str;
}

export function toCsv(rows: Record<string, unknown>[], columns: [string, string][]): string {
  const head = columns.map(([, label]) => csvEscape(label)).join(',');
  return [head, ...rows.map((r) => columns.map(([key]) => csvEscape(r[key])).join(','))].join('\r\n');
}

export async function ticketRoutes(app: FastifyInstance) {
  app.get('/tickets', { config: { perm: 'tickets.read' } }, async (req) => listTickets(app, req, req.query as Record<string, unknown>));

  /**
   * CSV export of the filtered ticket list. `columns` (comma separated keys of
   * TICKET_EXPORT_COLUMNS) chooses and orders the columns; the default set is
   * used when it is omitted.
   */
  app.get('/tickets/export.csv', { config: { perm: 'tickets.read' } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const wanted = String(q.columns ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    const columns = wanted.length
      ? wanted.map((k) => TICKET_EXPORT_COLUMNS.find((c) => c.key === k)).filter((c): c is (typeof TICKET_EXPORT_COLUMNS)[number] => !!c)
      : TICKET_EXPORT_COLUMNS.filter((c) => c.default);
    if (!columns.length) throw badRequest('Choose at least one column');
    const result = await listTickets(app, req, { ...q, page: 1, pageSize: 500 }, 10000);
    const ids = result.data.map((r) => r.id);
    const keys = new Set<string>(columns.map((c) => c.key));
    const needsExtra = ['description', 'resolution', 'contactEmail', 'accountNumber', 'subIssueTypeName', 'sourceName', 'closedAt'].some((k) => keys.has(k));
    const extra = new Map<number, Record<string, unknown>>();
    if (needsExtra && ids.length) {
      const rows = await app.db
        .select({
          id: s.tickets.id,
          description: s.tickets.description,
          resolution: s.tickets.resolution,
          closedAt: s.tickets.closedAt,
          contactEmail: s.contacts.email,
          accountNumber: s.companies.accountNumber,
          subIssueTypeName: s.subIssueTypes.name,
          sourceName: s.ticketSources.name,
        })
        .from(s.tickets)
        .innerJoin(s.companies, eq(s.companies.id, s.tickets.companyId))
        .leftJoin(s.contacts, eq(s.contacts.id, s.tickets.contactId))
        .leftJoin(s.subIssueTypes, eq(s.subIssueTypes.id, s.tickets.subIssueTypeId))
        .leftJoin(s.ticketSources, eq(s.ticketSources.id, s.tickets.sourceId))
        .where(inArray(s.tickets.id, ids));
      for (const r of rows) extra.set(r.id, r);
    }
    const notes = new Map<number, string>();
    if (keys.has('notes') && ids.length) {
      const author = alias(s.users, 'note_author');
      const rows = await app.db
        .select({ ticketId: s.ticketNotes.ticketId, body: s.ticketNotes.body, visibility: s.ticketNotes.visibility, createdAt: s.ticketNotes.createdAt, author: fullName(author) })
        .from(s.ticketNotes)
        .leftJoin(author, eq(author.id, s.ticketNotes.userId))
        .where(inArray(s.ticketNotes.ticketId, ids))
        .orderBy(asc(s.ticketNotes.createdAt), asc(s.ticketNotes.id));
      for (const n of rows) {
        const head = `[${n.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${n.author ? ` · ${n.author}` : ''}${n.visibility === 'public' ? ' · customer-visible' : ''}]`;
        const prev = notes.get(n.ticketId);
        notes.set(n.ticketId, `${prev ? `${prev}\n\n` : ''}${head}\n${n.body}`);
      }
    }
    const csv = toCsv(
      result.data.map((r) => ({
        ...r,
        ...extra.get(r.id),
        notes: notes.get(r.id) ?? '',
        slaState: r.sla.overall,
        hoursWorked: (r.minutesWorked / 60).toFixed(2),
      })),
      columns.map((c) => [c.key, c.label]),
    );
    // UTF-8 BOM so Excel shows accented characters correctly.
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="tickets.csv"').send(`\uFEFF${csv}`);
  });

  /** Lightweight counters for sidebar badges and the "My Work" header. */
  app.get('/tickets/counts', { config: { perm: 'tickets.read' } }, async (req) => {
    const me = currentUser(req);
    const [row] = await app.db
      .execute<{ mine: number; unassigned: number; open: number; breached: number; waiting: number; atRisk: number }>(
        sql`select
          count(*) filter (where t.assigned_user_id = ${me.id})::int as mine,
          count(*) filter (where t.assigned_user_id is null)::int as unassigned,
          count(*)::int as open,
          count(*) filter (where t.first_response_breached or t.resolution_breached
            or (t.sla_paused_at is null and t.resolution_due_at < now())
            or (t.first_response_at is null and t.first_response_due_at < now()))::int as breached,
          count(*) filter (where st.category = 'waiting')::int as waiting,
          count(*) filter (where t.sla_paused_at is null and t.resolution_due_at between now() and now() + interval '1 hour')::int as "atRisk"
        from tickets t join ticket_statuses st on st.id = t.status_id
        where st.category not in ('resolved','closed')`,
      )
      .then((r) => r.rows);
    return row;
  });

  /** Possible duplicates: open tickets of the same company sharing the CI or title words. */
  app.get('/tickets/duplicates', { config: { perm: 'tickets.read' } }, async (req) => {
    const q = req.query as Record<string, string>;
    const companyId = intParam(q.companyId);
    if (!companyId) return { data: [] };
    const words = String(q.title ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
      .slice(0, 6);
    const ciId = intParam(q.configurationItemId);
    const contactId = intParam(q.contactId);
    const excludeId = intParam(q.excludeId);
    const matchers: SQL[] = words.map((w) => sql`${s.tickets.title} ilike ${likeTerm(w)}`);
    if (ciId) matchers.push(eq(s.tickets.configurationItemId, ciId));
    if (!matchers.length && !contactId) return { data: [] };
    if (contactId && words.length) matchers.push(eq(s.tickets.contactId, contactId));
    const score = sql<number>`(${sql.join(
      [...words.map((w) => sql`(case when ${s.tickets.title} ilike ${likeTerm(w)} then 1 else 0 end)`), ciId ? sql`(case when ${s.tickets.configurationItemId} = ${ciId} then 3 else 0 end)` : sql`0`],
      sql` + `,
    )})`;
    const rows = await app.db
      .select({
        id: s.tickets.id,
        ticketNumber: s.tickets.ticketNumber,
        title: s.tickets.title,
        statusName: s.ticketStatuses.name,
        statusColor: s.ticketStatuses.color,
        createdAt: s.tickets.createdAt,
        score,
      })
      .from(s.tickets)
      .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
      .where(
        and(
          eq(s.tickets.companyId, companyId),
          sql`${s.ticketStatuses.category} not in ('resolved','closed')`,
          excludeId ? ne(s.tickets.id, excludeId) : undefined,
          or(...matchers),
        ),
      )
      .orderBy(desc(score), desc(s.tickets.createdAt))
      .limit(5);
    return { data: rows.filter((r) => r.score >= Math.min(2, Math.max(1, words.length))) };
  });

  app.get('/tickets/:id', { config: { perm: 'tickets.read' } }, async (req) => {
    const id = idOf(req);
    const creator = alias(s.users, 'creator');
    const [row] = await app.db
      .select({
        t: s.tickets,
        companyName: s.companies.name,
        companyPhone: s.companies.phone,
        companyLogoUpdatedAt: s.companies.logoUpdatedAt,
        contactName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
        contactEmail: s.contacts.email,
        contactPhone: s.contacts.phone,
        contactMobile: s.contacts.mobile,
        contactTitle: s.contacts.title,
        locationName: s.locations.name,
        assigneeName: fullName(assignee),
        assigneeEmail: assignee.email,
        creatorName: fullName(creator),
        queueName: s.queues.name,
        statusName: s.ticketStatuses.name,
        statusColor: s.ticketStatuses.color,
        statusCategory: s.ticketStatuses.category,
        priorityName: s.ticketPriorities.name,
        priorityColor: s.ticketPriorities.color,
        priorityLevel: s.ticketPriorities.level,
        ticketTypeName: s.ticketTypes.name,
        issueTypeName: s.issueTypes.name,
        subIssueTypeName: s.subIssueTypes.name,
        sourceName: s.ticketSources.name,
        slaName: s.slaPolicies.name,
        contractName: s.contracts.name,
        contractType: s.contracts.type,
        projectName: s.projects.name,
      })
      .from(s.tickets)
      .innerJoin(s.companies, eq(s.companies.id, s.tickets.companyId))
      .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
      .innerJoin(s.ticketPriorities, eq(s.ticketPriorities.id, s.tickets.priorityId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.tickets.contactId))
      .leftJoin(s.locations, eq(s.locations.id, s.tickets.locationId))
      .leftJoin(assignee, eq(assignee.id, s.tickets.assignedUserId))
      .leftJoin(creator, eq(creator.id, s.tickets.createdById))
      .leftJoin(s.queues, eq(s.queues.id, s.tickets.queueId))
      .leftJoin(s.ticketTypes, eq(s.ticketTypes.id, s.tickets.ticketTypeId))
      .leftJoin(s.issueTypes, eq(s.issueTypes.id, s.tickets.issueTypeId))
      .leftJoin(s.subIssueTypes, eq(s.subIssueTypes.id, s.tickets.subIssueTypeId))
      .leftJoin(s.ticketSources, eq(s.ticketSources.id, s.tickets.sourceId))
      .leftJoin(s.slaPolicies, eq(s.slaPolicies.id, s.tickets.slaId))
      .leftJoin(s.contracts, eq(s.contracts.id, s.tickets.contractId))
      .leftJoin(s.projects, eq(s.projects.id, s.tickets.projectId))
      .where(eq(s.tickets.id, id));
    if (!row) throw notFound('Ticket');
    const { t, ...names } = row;
    const me = currentUser(req);
    const [time] = await app.db.execute<{ minutes: number; billable: number }>(
      sql`select coalesce(sum(duration_minutes),0)::int as minutes, coalesce(sum(duration_minutes) filter (where billable),0)::int as billable from time_entries where ticket_id = ${id}`,
    ).then((r) => r.rows);
    const watchers = await app.db
      .select({ userId: s.ticketWatchers.userId, name: fullName(s.users) })
      .from(s.ticketWatchers)
      .innerJoin(s.users, eq(s.users.id, s.ticketWatchers.userId))
      .where(eq(s.ticketWatchers.ticketId, id));
    const { slaWarningMinutes } = await getSystemSettings(app.db);
    return {
      ...t,
      ...names,
      minutesWorked: time?.minutes ?? 0,
      billableMinutes: time?.billable ?? 0,
      watchers,
      isWatching: watchers.some((w) => w.userId === me.id),
      sla: slaSummary(t, slaWarningMinutes),
    };
  });

  /** Merged timeline: notes, lifecycle events and time entries. */
  app.get('/tickets/:id/timeline', { config: { perm: 'tickets.read' } }, async (req) => {
    const id = idOf(req);
    await getTicketRow(app.db, id);
    const [notes, events, time, files] = await Promise.all([
      app.db
        .select({ note: s.ticketNotes, userName: fullName(s.users) })
        .from(s.ticketNotes)
        .leftJoin(s.users, eq(s.users.id, s.ticketNotes.userId))
        .where(eq(s.ticketNotes.ticketId, id)),
      app.db
        .select({ event: s.ticketEvents, userName: fullName(s.users) })
        .from(s.ticketEvents)
        .leftJoin(s.users, eq(s.users.id, s.ticketEvents.userId))
        .where(and(eq(s.ticketEvents.ticketId, id), ne(s.ticketEvents.type, 'note_added'))),
      app.db
        .select({ entry: s.timeEntries, userName: fullName(s.users), workTypeName: s.workTypes.name })
        .from(s.timeEntries)
        .innerJoin(s.users, eq(s.users.id, s.timeEntries.userId))
        .leftJoin(s.workTypes, eq(s.workTypes.id, s.timeEntries.workTypeId))
        .where(eq(s.timeEntries.ticketId, id)),
      app.db
        .select({ file: s.attachments, userName: fullName(s.users) })
        .from(s.attachments)
        .leftJoin(s.users, eq(s.users.id, s.attachments.uploadedById))
        .where(and(eq(s.attachments.entityType, 'ticket'), eq(s.attachments.entityId, id))),
    ]);
    // Resolve ids mentioned in field-change events into display names.
    const lookupIds = { user: new Set<number>(), queue: new Set<number>(), priority: new Set<number>() };
    for (const { event } of events) {
      const d = event.data as Record<string, unknown>;
      const field = event.type === 'assigned' ? 'assignedUserId' : (d.field as string);
      const bucket = field === 'assignedUserId' ? lookupIds.user : field === 'queueId' ? lookupIds.queue : field === 'priorityId' ? lookupIds.priority : null;
      if (bucket) for (const v of [d.from, d.to]) if (typeof v === 'number') bucket.add(v);
    }
    const [userNames, queueNames, priorityNames] = await Promise.all([
      lookupIds.user.size ? app.db.select({ id: s.users.id, name: fullName(s.users) }).from(s.users).where(inArray(s.users.id, [...lookupIds.user])) : [],
      lookupIds.queue.size ? app.db.select({ id: s.queues.id, name: s.queues.name }).from(s.queues).where(inArray(s.queues.id, [...lookupIds.queue])) : [],
      lookupIds.priority.size ? app.db.select({ id: s.ticketPriorities.id, name: s.ticketPriorities.name }).from(s.ticketPriorities).where(inArray(s.ticketPriorities.id, [...lookupIds.priority])) : [],
    ]);
    const names = {
      assignedUserId: new Map(userNames.map((u) => [u.id, u.name])),
      queueId: new Map(queueNames.map((u) => [u.id, u.name])),
      priorityId: new Map(priorityNames.map((u) => [u.id, u.name])),
    } as Record<string, Map<number, string | null>>;

    const items = [
      ...notes.map(({ note, userName }) => ({ kind: 'note' as const, id: `n${note.id}`, at: note.createdAt, userName, note })),
      ...events.map(({ event, userName }) => {
        const d = { ...(event.data as Record<string, unknown>) };
        const field = event.type === 'assigned' ? 'assignedUserId' : (d.field as string);
        const map = names[field];
        if (map) {
          d.fromLabel = typeof d.from === 'number' ? map.get(d.from) : null;
          d.toLabel = typeof d.to === 'number' ? map.get(d.to) : null;
        }
        return { kind: 'event' as const, id: `e${event.id}`, at: event.createdAt, userName, event: { ...event, data: d } };
      }),
      ...time.map(({ entry, userName, workTypeName }) => ({ kind: 'time' as const, id: `t${entry.id}`, at: entry.startedAt, userName, entry: { ...entry, workTypeName } })),
      ...files.map(({ file, userName }) => ({ kind: 'attachment' as const, id: `a${file.id}`, at: file.createdAt, userName, file })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { data: items };
  });

  app.post('/tickets', { config: { perm: 'tickets.write' } }, async (req, reply) => {
    const input = ticketSchema.parse(req.body);
    const me = currentUser(req);
    const ticket = await app.db.transaction(async (tx) => {
      const t = await createTicket({ db: tx, userId: me.id }, input);
      await audit(tx, req, { action: 'create', entityType: 'ticket', entityId: t.id, summary: `${t.ticketNumber} ${t.title}` });
      return t;
    });
    await runTicketRules(app.db, 'ticket.created', ticket.id);
    return reply.status(201).send(await getTicketRow(app.db, ticket.id));
  });

  app.patch('/tickets/:id', { config: { perm: 'tickets.write' } }, async (req) => {
    const id = idOf(req);
    const input = ticketUpdateSchema.parse(req.body);
    const body = req.body as Record<string, unknown>;
    const patch = Object.fromEntries(Object.entries(input).filter(([k]) => k in body));
    const me = currentUser(req);
    const result = await app.db.transaction(async (tx) => {
      const r = await updateTicket({ db: tx, userId: me.id }, id, patch);
      if (r.changed.length) await audit(tx, req, { action: 'update', entityType: 'ticket', entityId: id, summary: r.ticket.ticketNumber, changes: { fields: r.changed } });
      return r;
    });
    if (result.changed.length) await runTicketRules(app.db, 'ticket.updated', id);
    return getTicketRow(app.db, id);
  });

  app.delete('/tickets/:id', { config: { perm: 'tickets.delete', forceDelete: { table: 'tickets' } } }, async (req) => {
    const id = idOf(req);
    const t = await getTicketRow(app.db, id);
    await app.db.transaction(async (tx) => {
      await tx.delete(s.tickets).where(eq(s.tickets.id, id));
      await audit(tx, req, { action: 'delete', entityType: 'ticket', entityId: id, summary: `${t.ticketNumber} ${t.title}` });
    });
    return { ok: true };
  });

  app.post('/tickets/bulk', { config: { perm: 'tickets.bulk' } }, async (req) => {
    const input = ticketBulkSchema.parse(req.body);
    const body = (req.body as { changes?: Record<string, unknown> }).changes ?? {};
    const changes = Object.fromEntries(Object.entries(input.changes).filter(([k]) => k in body));
    if (!Object.keys(changes).length) throw badRequest('No changes supplied');
    const me = currentUser(req);
    const changedIds: number[] = [];
    await app.db.transaction(async (tx) => {
      for (const id of input.ids) {
        const r = await updateTicket({ db: tx, userId: me.id }, id, changes);
        if (r.changed.length) changedIds.push(id);
      }
      await audit(tx, req, { action: 'update', entityType: 'ticket', summary: `Bulk update of ${input.ids.length} tickets`, changes: { ids: input.ids, ...changes } });
    });
    for (const id of changedIds) await runTicketRules(app.db, 'ticket.updated', id);
    return { updated: changedIds.length };
  });

  /* ---------------------------------------------------------------- notes */

  app.post('/tickets/:id/notes', { config: { perm: 'tickets.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = ticketNoteSchema.parse(req.body);
    const me = currentUser(req);
    const before = await getTicketRow(app.db, id);
    const note = await app.db.transaction((tx) => addTicketNote({ db: tx, userId: me.id }, id, input));
    if (input.notifyContact && input.visibility === 'public' && before.contactId) {
      await enqueue(app.db, 'email.customer_note', { noteId: note.id }, { maxAttempts: 3 });
    }
    if (input.statusId && input.statusId !== before.statusId) await runTicketRules(app.db, 'ticket.updated', id);
    await emitTicketEvent(app.db, 'ticket.note_added', id, { note: { id: note.id, body: note.body, visibility: note.visibility, authorId: me.id, createdAt: note.createdAt } });
    return reply.status(201).send(note);
  });

  app.patch('/tickets/:id/notes/:noteId', { config: { perm: 'tickets.write' } }, async (req) => {
    const noteId = idOf(req, 'noteId');
    const me = currentUser(req);
    const input = ticketNoteSchema.partial().parse(req.body);
    const [note] = await app.db.select().from(s.ticketNotes).where(eq(s.ticketNotes.id, noteId));
    if (!note || note.ticketId !== idOf(req)) throw notFound('Note');
    if (note.userId !== me.id && !can(req, 'tickets.delete')) throw forbidden('Only the author can edit this note');
    const [row] = await app.db
      .update(s.ticketNotes)
      .set({ ...(input.body ? { body: input.body } : {}), ...(input.visibility ? { visibility: input.visibility } : {}) })
      .where(eq(s.ticketNotes.id, noteId))
      .returning();
    return row;
  });

  app.delete('/tickets/:id/notes/:noteId', { config: { perm: 'tickets.write' } }, async (req) => {
    const noteId = idOf(req, 'noteId');
    const me = currentUser(req);
    const [note] = await app.db.select().from(s.ticketNotes).where(eq(s.ticketNotes.id, noteId));
    if (!note || note.ticketId !== idOf(req)) throw notFound('Note');
    if (note.userId !== me.id && !can(req, 'tickets.delete')) throw forbidden('Only the author can delete this note');
    await app.db.delete(s.ticketNotes).where(eq(s.ticketNotes.id, noteId));
    await audit(app.db, req, { action: 'delete', entityType: 'ticket_note', entityId: noteId, summary: `Note on ticket ${note.ticketId}` });
    return { ok: true };
  });

  /* ------------------------------------------------------------- watchers */

  app.post('/tickets/:id/watch', { config: { perm: 'tickets.read' } }, async (req) => {
    const id = idOf(req);
    await getTicketRow(app.db, id);
    const body = (req.body ?? {}) as { userId?: number };
    const userId = body.userId && can(req, 'tickets.write') ? body.userId : currentUser(req).id;
    await app.db.insert(s.ticketWatchers).values({ ticketId: id, userId }).onConflictDoNothing();
    return { ok: true };
  });
  app.delete('/tickets/:id/watch', { config: { perm: 'tickets.read' } }, async (req) => {
    const id = idOf(req);
    const userId = intParam((req.query as Record<string, string>).userId) ?? currentUser(req).id;
    if (userId !== currentUser(req).id && !can(req, 'tickets.write')) throw forbidden();
    await app.db.delete(s.ticketWatchers).where(and(eq(s.ticketWatchers.ticketId, id), eq(s.ticketWatchers.userId, userId)));
    return { ok: true };
  });

  /* ------------------------------------------------------------ relations */

  app.get('/tickets/:id/relations', { config: { perm: 'tickets.read' } }, async (req) => {
    const id = idOf(req);
    const rows = await app.db.execute(sql`
      select r.id, r.type, case when r.ticket_id = ${id} then 'outgoing' else 'incoming' end as direction,
             t.id as "ticketId", t.ticket_number as "ticketNumber", t.title, st.name as "statusName", st.color as "statusColor", st.category as "statusCategory"
      from ticket_relations r
      join tickets t on t.id = case when r.ticket_id = ${id} then r.related_ticket_id else r.ticket_id end
      join ticket_statuses st on st.id = t.status_id
      where r.ticket_id = ${id} or r.related_ticket_id = ${id}
      order by r.created_at desc`);
    return { data: rows.rows };
  });

  app.post('/tickets/:id/relations', { config: { perm: 'tickets.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = ticketRelationSchema.parse(req.body);
    if (input.relatedTicketId === id) throw badRequest('A ticket cannot be related to itself');
    await getTicketRow(app.db, input.relatedTicketId);
    const [row] = await app.db.insert(s.ticketRelations).values({ ticketId: id, ...input }).onConflictDoNothing().returning();
    await app.db.insert(s.ticketEvents).values({ ticketId: id, userId: currentUser(req).id, type: 'relation_added', data: { relatedTicketId: input.relatedTicketId, type: input.type } });
    return reply.status(201).send(row ?? { ok: true });
  });

  app.delete('/tickets/:id/relations/:relationId', { config: { perm: 'tickets.write' } }, async (req) => {
    const id = idOf(req);
    await app.db
      .delete(s.ticketRelations)
      .where(and(eq(s.ticketRelations.id, idOf(req, 'relationId')), or(eq(s.ticketRelations.ticketId, id), eq(s.ticketRelations.relatedTicketId, id))));
    return { ok: true };
  });

  /* ---------------------------------------------------------- saved views */

  app.get('/saved-views', async (req) => {
    const me = currentUser(req);
    const entity = (req.query as { entity?: string }).entity ?? 'tickets';
    const rows = await app.db
      .select()
      .from(s.savedViews)
      .where(and(eq(s.savedViews.entity, entity), or(eq(s.savedViews.userId, me.id), eq(s.savedViews.isShared, true))))
      .orderBy(asc(s.savedViews.name));
    return { data: rows.map((r) => ({ ...r, isOwner: r.userId === me.id })) };
  });
  app.post('/saved-views', async (req, reply) => {
    const input = savedViewSchema.parse(req.body);
    const [row] = await app.db.insert(s.savedViews).values({ ...input, userId: currentUser(req).id }).returning();
    return reply.status(201).send(row);
  });
  app.delete('/saved-views/:id', async (req) => {
    await app.db.delete(s.savedViews).where(and(eq(s.savedViews.id, idOf(req)), eq(s.savedViews.userId, currentUser(req).id)));
    return { ok: true };
  });
}

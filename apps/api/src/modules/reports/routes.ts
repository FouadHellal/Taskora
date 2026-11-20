import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { badRequest } from '../../lib/errors.js';
import { idList } from '../../lib/query.js';
import { currentUser } from '../../lib/context.js';
import { toCsv } from '../tickets/routes.js';

interface Range {
  from: Date;
  to: Date;
}

function range(q: Record<string, unknown>): Range {
  const to = q.to ? new Date(String(q.to)) : new Date();
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 30 * 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('Invalid date range');
  // An inclusive "to" date covers the whole day.
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(String(q.to))) to.setUTCHours(23, 59, 59, 999);
  return { from, to };
}

/** Ticket filter fragment (alias t) from common query params. */
function ticketScope(req: FastifyRequest, q: Record<string, unknown>): SQL {
  const parts: SQL[] = [sql`true`];
  const companies = idList(q.companyId);
  if (companies.length) parts.push(sql`t.company_id in ${companies}`);
  const queues = idList(q.queueId);
  if (queues.length) parts.push(sql`t.queue_id in ${queues}`);
  if (q.userId === 'me') parts.push(sql`t.assigned_user_id = ${currentUser(req).id}`);
  else if (idList(q.userId).length) parts.push(sql`t.assigned_user_id in ${idList(q.userId)}`);
  return sql.join(parts, sql` and `);
}

function timeScope(req: FastifyRequest, q: Record<string, unknown>): SQL {
  const parts: SQL[] = [sql`true`];
  const companies = idList(q.companyId);
  if (companies.length) parts.push(sql`te.company_id in ${companies}`);
  if (q.userId === 'me') parts.push(sql`te.user_id = ${currentUser(req).id}`);
  else if (idList(q.userId).length) parts.push(sql`te.user_id in ${idList(q.userId)}`);
  return sql.join(parts, sql` and `);
}

function sendMaybeCsv(req: FastifyRequest, reply: FastifyReply, rows: Record<string, unknown>[], name: string) {
  if ((req.query as { format?: string }).format !== 'csv') return { data: rows };
  const cols = rows[0] ? Object.keys(rows[0]).map((k) => [k, k] as [string, string]) : [];
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}.csv"`)
    .send(toCsv(rows, cols));
}

export async function reportRoutes(app: FastifyInstance) {
  const rows = <T>(q: SQL) => app.db.execute<T & Record<string, unknown>>(q).then((r) => r.rows);

  app.get('/dashboard', { config: { perm: 'dashboard.read' } }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const { from, to } = range(q);
    const scope = ticketScope(req, q);
    const tscope = timeScope(req, q);

    const [kpi] = await rows<Record<string, number>>(sql`
      select
        count(*) filter (where st.category not in ('resolved','closed'))::int as "openTickets",
        count(*) filter (where st.category not in ('resolved','closed') and t.assigned_user_id is null)::int as "unassigned",
        count(*) filter (where st.category = 'waiting')::int as "waiting",
        count(*) filter (where st.category not in ('resolved','closed') and p.level = 1)::int as "critical",
        count(*) filter (where st.category not in ('resolved','closed') and (t.first_response_breached or t.resolution_breached
          or (t.sla_paused_at is null and t.resolution_due_at < now()) or (t.first_response_at is null and t.first_response_due_at < now())))::int as "slaBreached",
        count(*) filter (where st.category not in ('resolved','closed') and t.sla_paused_at is null and t.resolution_due_at between now() and now() + interval '1 hour')::int as "slaAtRisk",
        count(*) filter (where t.created_at between ${from} and ${to})::int as "created",
        count(*) filter (where t.resolved_at between ${from} and ${to})::int as "resolved",
        coalesce(round(avg(extract(epoch from (t.first_response_at - t.created_at)) / 60) filter (where t.created_at between ${from} and ${to} and t.first_response_at is not null)), 0)::int as "avgFirstResponseMinutes",
        coalesce(round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 60) filter (where t.resolved_at between ${from} and ${to})), 0)::int as "avgResolutionMinutes",
        coalesce(round(100.0 * count(*) filter (where t.resolved_at between ${from} and ${to} and not t.resolution_breached and not t.first_response_breached and t.resolution_due_at is not null)
          / nullif(count(*) filter (where t.resolved_at between ${from} and ${to} and t.resolution_due_at is not null), 0)), 100)::int as "slaCompliance"
      from tickets t join ticket_statuses st on st.id = t.status_id join ticket_priorities p on p.id = t.priority_id
      where ${scope}`);

    const [time] = await rows<Record<string, number>>(sql`
      select coalesce(sum(duration_minutes),0)::int as "minutes",
             coalesce(sum(duration_minutes - coalesce(covered_minutes, case when contract_covered then duration_minutes else 0 end)) filter (where billable),0)::int as "billableMinutes",
             coalesce(sum(coalesce(covered_minutes, case when contract_covered then duration_minutes else 0 end)),0)::int as "coveredMinutes"
      from time_entries te where te.started_at between ${from} and ${to} and ${tscope}`);

    const [assets] = await rows<Record<string, number>>(sql`
      select
        (select count(*) from companies where is_active and type = 'customer')::int as "activeCompanies",
        (select count(*) from configuration_items where lifecycle_status = 'active')::int as "managedCis",
        (select count(*) from action1_endpoints)::int as "syncedEndpoints",
        (select count(*) from action1_endpoints e where e.reboot_required or coalesce(e.missing_critical_updates,0) > 0 or e.agent_status = 'Disconnected')::int as "devicesAttention",
        (select count(*) from action1_endpoints where match_status in ('unmatched','conflict'))::int as "endpointsNeedReview",
        (select count(*) from configuration_items where warranty_expires_at between current_date and current_date + 60)::int as "warrantyExpiring"`);

    const [integration] = await rows<Record<string, unknown>>(sql`
      select enabled, status, last_sync_at as "lastSyncAt", last_success_at as "lastSuccessAt", last_error as "lastError"
      from integrations where provider = 'action1'`);

    const byStatus = await rows(sql`
      select st.id, st.name, st.color, count(t.id)::int as count
      from ticket_statuses st left join tickets t on t.status_id = st.id and ${scope}
      where st.category not in ('closed') and st.is_active group by st.id order by st.sort_order`);
    const byPriority = await rows(sql`
      select p.id, p.name, p.color, count(t.id)::int as count
      from ticket_priorities p left join tickets t on t.priority_id = p.id and ${scope}
        and t.status_id in (select id from ticket_statuses where category not in ('resolved','closed'))
      group by p.id order by p.level`);
    const byQueue = await rows(sql`
      select coalesce(q.name, 'No queue') as name, q.id, count(*)::int as count
      from tickets t join ticket_statuses st on st.id = t.status_id left join queues q on q.id = t.queue_id
      where st.category not in ('resolved','closed') and ${scope} group by q.id, q.name order by count desc limit 10`);
    const workload = await rows(sql`
      select u.id, u.first_name || ' ' || u.last_name as name,
        (select count(*) from tickets t join ticket_statuses st on st.id = t.status_id
          where t.assigned_user_id = u.id and st.category not in ('resolved','closed') and ${scope})::int as "openTickets",
        (select count(*) from tickets t join ticket_statuses st on st.id = t.status_id join ticket_priorities p on p.id = t.priority_id
          where t.assigned_user_id = u.id and st.category not in ('resolved','closed') and p.level <= 2 and ${scope})::int as "highPriority",
        (select coalesce(sum(te.duration_minutes),0) from time_entries te where te.user_id = u.id and te.started_at between ${from} and ${to})::int as "minutes"
      from users u where u.is_active and u.is_technician order by "openTickets" desc, name limit 15`);
    const trend = await rows(sql`
      with days as (select generate_series(date_trunc('day', ${from}::timestamptz), date_trunc('day', ${to}::timestamptz), interval '1 day') as d)
      select to_char(d, 'YYYY-MM-DD') as day,
        (select count(*) from tickets t where date_trunc('day', t.created_at) = d and ${scope})::int as created,
        (select count(*) from tickets t where date_trunc('day', t.resolved_at) = d and ${scope})::int as resolved
      from days order by d`);
    const attentionDevices = await rows(sql`
      select c.id, c.name, co.name as "companyName", e.agent_status as "agentStatus", e.reboot_required as "rebootRequired",
             e.missing_critical_updates as "missingCriticalUpdates", e.last_seen_at as "lastSeenAt"
      from action1_endpoints e join configuration_items c on c.id = e.configuration_item_id join companies co on co.id = c.company_id
      where e.reboot_required or coalesce(e.missing_critical_updates,0) > 0 or e.agent_status = 'Disconnected'
      order by coalesce(e.missing_critical_updates,0) desc, e.last_seen_at asc nulls first limit 8`);

    return { range: { from, to }, kpi, time, assets, integration: integration ?? null, byStatus, byPriority, byQueue, workload, trend, attentionDevices };
  });

  /** Personal workspace summary for "My Work". */
  app.get('/my-work', async (req) => {
    const me = currentUser(req);
    const [summary] = await rows<Record<string, number>>(sql`
      select
        count(*) filter (where st.category not in ('resolved','closed'))::int as "open",
        count(*) filter (where st.category = 'new')::int as "new",
        count(*) filter (where st.category = 'waiting')::int as "waiting",
        count(*) filter (where st.category not in ('resolved','closed') and coalesce(t.due_at, t.resolution_due_at) < now() + interval '1 day')::int as "dueSoon",
        count(*) filter (where st.category not in ('resolved','closed') and (t.first_response_breached or t.resolution_breached
          or (t.sla_paused_at is null and t.resolution_due_at < now())))::int as "breached"
      from tickets t join ticket_statuses st on st.id = t.status_id where t.assigned_user_id = ${me.id}`);
    const [time] = await rows<Record<string, number>>(sql`
      select coalesce(sum(duration_minutes) filter (where started_at >= date_trunc('day', now())),0)::int as today,
             coalesce(sum(duration_minutes) filter (where started_at >= date_trunc('week', now())),0)::int as week
      from time_entries where user_id = ${me.id}`);
    const tasks = await rows(sql`
      select pt.id, pt.title, pt.status, pt.due_date::text as "dueDate", p.id as "projectId", p.name as "projectName"
      from project_tasks pt join projects p on p.id = pt.project_id
      where pt.assigned_user_id = ${me.id} and pt.status <> 'done' order by pt.due_date asc nulls last limit 10`);
    const calls = await rows(sql`
      select sc.id, sc.title, sc.start_at as "startAt", sc.end_at as "endAt", c.name as "companyName"
      from service_calls sc join service_call_users u on u.service_call_id = sc.id join companies c on c.id = sc.company_id
      where u.user_id = ${me.id} and sc.end_at >= now() and sc.status <> 'cancelled' order by sc.start_at limit 6`);
    return { summary, time, tasks, serviceCalls: calls };
  });

  /* ------------------------------------------------------------- reports */

  app.get('/reports/tickets', { config: { perm: 'reports.read' } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const { from, to } = range(q);
    const groups: Record<string, [SQL, SQL]> = {
      company: [sql`co.name`, sql`join companies co on co.id = t.company_id`],
      queue: [sql`coalesce(q.name,'No queue')`, sql`left join queues q on q.id = t.queue_id`],
      priority: [sql`p.name`, sql`join ticket_priorities p on p.id = t.priority_id`],
      status: [sql`st2.name`, sql`join ticket_statuses st2 on st2.id = t.status_id`],
      type: [sql`coalesce(tt.name,'Unspecified')`, sql`left join ticket_types tt on tt.id = t.ticket_type_id`],
      issue: [sql`coalesce(it.name,'Unspecified')`, sql`left join issue_types it on it.id = t.issue_type_id`],
      assignee: [sql`coalesce(u.first_name || ' ' || u.last_name, 'Unassigned')`, sql`left join users u on u.id = t.assigned_user_id`],
      source: [sql`coalesce(src.name,'Unspecified')`, sql`left join ticket_sources src on src.id = t.source_id`],
    };
    const g = groups[String(q.group ?? 'company')];
    if (!g) throw badRequest('Unknown grouping');
    const data = await rows(sql`
      select ${g[0]} as "group",
        count(*) filter (where t.created_at between ${from} and ${to})::int as created,
        count(*) filter (where t.resolved_at between ${from} and ${to})::int as resolved,
        count(*) filter (where st.category not in ('resolved','closed'))::int as open,
        coalesce(round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 3600.0) filter (where t.resolved_at between ${from} and ${to})::numeric, 1), 0)::float as "avgResolutionHours",
        count(*) filter (where (t.first_response_breached or t.resolution_breached) and t.created_at between ${from} and ${to})::int as "slaBreaches",
        coalesce((select sum(te.duration_minutes) from time_entries te where te.ticket_id = any(array_agg(t.id)) and te.started_at between ${from} and ${to}), 0)::int as "minutesWorked"
      from tickets t join ticket_statuses st on st.id = t.status_id ${g[1]}
      where ${ticketScope(req, q)} and (t.created_at between ${from} and ${to} or t.resolved_at between ${from} and ${to} or st.category not in ('resolved','closed'))
      group by 1 order by created desc, open desc`);
    return sendMaybeCsv(req, reply, data, 'tickets-report');
  });

  app.get('/reports/time', { config: { perm: 'reports.read' } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const { from, to } = range(q);
    const groups: Record<string, [SQL, SQL]> = {
      user: [sql`u.first_name || ' ' || u.last_name`, sql`join users u on u.id = te.user_id`],
      company: [sql`co.name`, sql`join companies co on co.id = te.company_id`],
      workType: [sql`coalesce(w.name,'Unspecified')`, sql`left join work_types w on w.id = te.work_type_id`],
      contract: [sql`coalesce(k.name,'No contract')`, sql`left join contracts k on k.id = te.contract_id`],
      project: [sql`coalesce(pr.name,'Service desk')`, sql`left join projects pr on pr.id = te.project_id`],
      day: [sql`to_char(te.started_at, 'YYYY-MM-DD')`, sql``],
    };
    const g = groups[String(q.group ?? 'user')];
    if (!g) throw badRequest('Unknown grouping');
    const data = await rows(sql`
      select ${g[0]} as "group",
        round(sum(te.duration_minutes) / 60.0, 2)::float as hours,
        round(coalesce(sum(te.duration_minutes - coalesce(te.covered_minutes, case when te.contract_covered then te.duration_minutes else 0 end)) filter (where te.billable), 0) / 60.0, 2)::float as "billableHours",
        round(coalesce(sum(coalesce(te.covered_minutes, case when te.contract_covered then te.duration_minutes else 0 end)), 0) / 60.0, 2)::float as "contractHours",
        round(coalesce(sum(te.duration_minutes) filter (where not te.billable), 0) / 60.0, 2)::float as "nonBillableHours",
        round(coalesce(sum((te.duration_minutes - coalesce(te.covered_minutes, case when te.contract_covered then te.duration_minutes else 0 end)) * coalesce(te.hourly_rate, 0) / 60.0) filter (where te.billable), 0), 2)::float as "billableAmount",
        count(*)::int as entries
      from time_entries te ${g[1]}
      where te.started_at between ${from} and ${to} and ${timeScope(req, q)}
      group by 1 order by ${String(q.group) === 'day' ? sql`1` : sql`hours desc`}`);
    return sendMaybeCsv(req, reply, data, 'time-report');
  });

  app.get('/reports/sla', { config: { perm: 'reports.read' } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const { from, to } = range(q);
    const by = String(q.group ?? 'priority');
    const g: Record<string, [SQL, SQL]> = {
      priority: [sql`p.name`, sql`join ticket_priorities p on p.id = t.priority_id`],
      company: [sql`co.name`, sql`join companies co on co.id = t.company_id`],
      sla: [sql`coalesce(sp.name,'No SLA')`, sql`left join sla_policies sp on sp.id = t.sla_id`],
      queue: [sql`coalesce(qu.name,'No queue')`, sql`left join queues qu on qu.id = t.queue_id`],
    };
    const sel = g[by];
    if (!sel) throw badRequest('Unknown grouping');
    const data = await rows(sql`
      select ${sel[0]} as "group",
        count(*)::int as tickets,
        count(*) filter (where t.first_response_due_at is not null)::int as "withFirstResponseTarget",
        count(*) filter (where t.first_response_due_at is not null and not t.first_response_breached and t.first_response_at is not null and t.first_response_at <= t.first_response_due_at)::int as "firstResponseMet",
        count(*) filter (where t.resolution_due_at is not null and t.resolved_at is not null)::int as "resolvedWithTarget",
        count(*) filter (where t.resolution_due_at is not null and t.resolved_at is not null and not t.resolution_breached)::int as "resolutionMet",
        coalesce(round(100.0 * count(*) filter (where t.resolution_due_at is not null and t.resolved_at is not null and not t.resolution_breached)
          / nullif(count(*) filter (where t.resolution_due_at is not null and t.resolved_at is not null), 0)), 100)::int as "resolutionCompliance"
      from tickets t ${sel[1]}
      where t.created_at between ${from} and ${to} and ${ticketScope(req, q)}
      group by 1 order by tickets desc`);
    return sendMaybeCsv(req, reply, data, 'sla-report');
  });

  app.get('/reports/assets', { config: { perm: 'reports.read' } }, async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const by = String(q.group ?? 'type');
    const g: Record<string, [SQL, SQL]> = {
      type: [sql`ct.name`, sql`join ci_types ct on ct.id = c.ci_type_id`],
      company: [sql`co.name`, sql`join companies co on co.id = c.company_id`],
      os: [sql`coalesce(c.os_name,'Unknown')`, sql``],
      lifecycle: [sql`c.lifecycle_status`, sql``],
      manufacturer: [sql`coalesce(c.manufacturer,'Unknown')`, sql``],
      source: [sql`c.source`, sql``],
    };
    const sel = g[by];
    if (!sel) throw badRequest('Unknown grouping');
    const companies = idList(q.companyId);
    const data = await rows(sql`
      select ${sel[0]} as "group", count(*)::int as total,
        count(*) filter (where c.lifecycle_status = 'active')::int as active,
        count(*) filter (where c.warranty_expires_at < current_date)::int as "warrantyExpired",
        count(*) filter (where c.warranty_expires_at between current_date and current_date + 90)::int as "warrantyExpiring90d",
        count(e.id)::int as "action1Managed",
        count(e.id) filter (where e.reboot_required or coalesce(e.missing_critical_updates,0) > 0)::int as "needsPatching"
      from configuration_items c ${sel[1]} left join action1_endpoints e on e.configuration_item_id = c.id
      where ${companies.length ? sql`c.company_id in ${companies}` : sql`true`}
      group by 1 order by total desc`);
    return sendMaybeCsv(req, reply, data, 'assets-report');
  });
}

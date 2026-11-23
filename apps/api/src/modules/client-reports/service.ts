/**
 * Monthly client reports: a snapshot of a company's month (tickets, work,
 * devices, Action1 patch status, an IT health score) that the IT team
 * publishes to the client portal. Reports are prepared automatically on the
 * configured day (draft for review, or published and e-mailed) or by hand.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db, Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { enqueue } from '../../jobs/queue.js';
import { monthLabel } from '../../jobs/client-email.js';
import { mailLang, mailTranslator } from '../../jobs/mail-i18n.js';
import { getSystemSettings, type SystemSettings } from '../../lib/settings.js';

export const REPORT_SECTIONS = ['tickets', 'work', 'devices', 'security'] as const;

const rows = async <T>(db: Tx, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;
const num = (v: unknown) => (v == null ? 0 : Number(v));
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : null);

/** First day of the month and of the next month, as YYYY-MM-DD. */
export function periodRange(period: string) {
  const [y, m] = period.split('-').map(Number);
  const from = new Date(Date.UTC(y!, m! - 1, 1));
  const to = new Date(Date.UTC(y!, m!, 1));
  const prev = new Date(Date.UTC(y!, m! - 2, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to), prevFrom: iso(prev) };
}

/** The month before `date` in the organization time zone, YYYY-MM. */
export function previousPeriod(tz: string, date = new Date()) {
  const local = localParts(tz, date);
  const d = new Date(Date.UTC(local.year, local.month - 2, 1));
  return d.toISOString().slice(0, 7);
}

function localParts(tz: string, date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

export function isPeriod(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

export interface HealthPart {
  key: 'patching' | 'sla' | 'resolution' | 'online' | 'reboots';
  score: number;
  weight: number;
}

/** Weighted 0–100 score from the parts that have data; null when nothing is measurable. */
export function healthScore(parts: (HealthPart | null)[]) {
  const ok = parts.filter((p): p is HealthPart => !!p);
  const w = ok.reduce((a, p) => a + p.weight, 0);
  if (!w) return { score: null, grade: null, parts: [] as HealthPart[] };
  const score = Math.round(ok.reduce((a, p) => a + p.score * p.weight, 0) / w);
  const grade = score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'poor';
  return { score, grade, parts: ok };
}

/** Action1 patch and availability status of the company's endpoints, right now. */
export async function securitySnapshot(db: Tx, companyId: number) {
  const orgs = await db.select({ externalId: s.action1Organizations.externalId }).from(s.action1Organizations).where(eq(s.action1Organizations.companyId, companyId));
  if (!orgs.length) return null;
  const eps = await db
    .select({
      name: sql<string>`coalesce(${s.action1Endpoints.deviceName}, ${s.action1Endpoints.name}, '')`,
      onlineStatus: s.action1Endpoints.onlineStatus,
      lastSeenAt: s.action1Endpoints.lastSeenAt,
      rebootRequired: s.action1Endpoints.rebootRequired,
      missingCritical: s.action1Endpoints.missingCriticalUpdates,
      missingOther: s.action1Endpoints.missingOtherUpdates,
      vulnerabilityStatus: s.action1Endpoints.vulnerabilityStatus,
      osName: s.action1Endpoints.osName,
      lastSyncedAt: s.action1Endpoints.lastSyncedAt,
    })
    .from(s.action1Endpoints)
    .where(and(inArray(s.action1Endpoints.orgExternalId, orgs.map((o) => o.externalId)), isNull(s.action1Endpoints.missingSince)));
  if (!eps.length) return null;
  const now = Date.now();
  const recent = (d: Date | null) => !!d && now - d.getTime() < 30 * 86400_000;
  const online = eps.filter((e) => (e.onlineStatus ?? '').toLowerCase() === 'online').length;
  const seenRecently = eps.filter((e) => recent(e.lastSeenAt) || (e.onlineStatus ?? '').toLowerCase() === 'online').length;
  const rebootRequired = eps.filter((e) => e.rebootRequired).length;
  const withCritical = eps.filter((e) => num(e.missingCritical) > 0).length;
  const upToDate = eps.filter((e) => num(e.missingCritical) === 0 && num(e.missingOther) === 0).length;
  const vulnerable = eps.filter((e) => e.vulnerabilityStatus && !/^(none|ok|no|secure|0)$/i.test(e.vulnerabilityStatus)).length;
  const attention = eps
    .filter((e) => num(e.missingCritical) > 0 || e.rebootRequired || !recent(e.lastSeenAt))
    .sort((a, b) => num(b.missingCritical) - num(a.missingCritical) || num(b.missingOther) - num(a.missingOther))
    .slice(0, 10)
    .map((e) => ({ name: e.name, missingCritical: num(e.missingCritical), missingOther: num(e.missingOther), rebootRequired: !!e.rebootRequired, lastSeenAt: e.lastSeenAt?.toISOString() ?? null }));
  const os = new Map<string, number>();
  for (const e of eps) {
    const k = (e.osName ?? 'Unknown').replace(/\s*\(.*\)$/, '').slice(0, 40);
    os.set(k, (os.get(k) ?? 0) + 1);
  }
  return {
    endpoints: eps.length,
    online,
    seenRecently,
    rebootRequired,
    withCriticalUpdates: withCritical,
    missingCritical: eps.reduce((a, e) => a + num(e.missingCritical), 0),
    missingOther: eps.reduce((a, e) => a + num(e.missingOther), 0),
    upToDate,
    patchedPct: pct(eps.length - withCritical, eps.length),
    fullyPatchedPct: pct(upToDate, eps.length),
    vulnerable,
    os: [...os.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    attention,
    lastSyncAt: eps.reduce<Date | null>((a, e) => (!a || (e.lastSyncedAt && e.lastSyncedAt > a) ? e.lastSyncedAt : a), null)?.toISOString() ?? null,
  };
}
export type SecuritySnapshot = NonNullable<Awaited<ReturnType<typeof securitySnapshot>>>;

export function securityHealthParts(sec: SecuritySnapshot | null): (HealthPart | null)[] {
  if (!sec) return [];
  return [
    sec.patchedPct == null ? null : { key: 'patching', score: sec.patchedPct, weight: 35 },
    { key: 'online', score: pct(sec.seenRecently, sec.endpoints) ?? 100, weight: 10 },
    { key: 'reboots', score: Math.round((1 - sec.rebootRequired / sec.endpoints) * 100), weight: 10 },
  ];
}

/** Everything a monthly report shows, for one company and one month. */
export async function buildReportData(db: Tx, companyId: number, period: string, tz: string) {
  const { from, to, prevFrom } = periodRange(period);
  const at = (d: string) => sql`(${d}::timestamp at time zone ${tz})`;
  const F = at(from);
  const T = at(to);
  const P = at(prevFrom);

  const [t] = await rows<Record<string, unknown>>(
    db,
    sql`select
      count(*) filter (where created_at >= ${F} and created_at < ${T}) as opened,
      count(*) filter (where resolved_at >= ${F} and resolved_at < ${T}) as resolved,
      count(*) filter (where created_at < ${T} and (resolved_at is null or resolved_at >= ${T})) as open_at_end,
      count(*) filter (where created_at >= ${P} and created_at < ${F}) as prev_opened,
      count(*) filter (where resolved_at >= ${P} and resolved_at < ${F}) as prev_resolved,
      avg(extract(epoch from (resolved_at - created_at)) / 3600) filter (where resolved_at >= ${F} and resolved_at < ${T}) as avg_hours,
      count(*) filter (where resolved_at >= ${F} and resolved_at < ${T} and resolution_due_at is not null) as sla_total,
      count(*) filter (where resolved_at >= ${F} and resolved_at < ${T} and resolution_due_at is not null and not resolution_breached) as sla_met
    from tickets where company_id = ${companyId}`,
  );
  const byPriority = await rows<{ name: string; color: string | null; count: number }>(
    db,
    sql`select p.name, p.color, count(*)::int as count from tickets t join ticket_priorities p on p.id = t.priority_id
        where t.company_id = ${companyId} and t.created_at >= ${F} and t.created_at < ${T}
        group by p.name, p.color, p.sort_order order by p.sort_order`,
  );
  const byCategory = await rows<{ name: string | null; count: number }>(
    db,
    sql`select it.name, count(*)::int as count from tickets t left join issue_types it on it.id = t.issue_type_id
        where t.company_id = ${companyId} and t.created_at >= ${F} and t.created_at < ${T}
        group by it.name order by count(*) desc limit 6`,
  );
  const topRequesters = await rows<{ name: string; count: number }>(
    db,
    sql`select c.first_name || ' ' || c.last_name as name, count(*)::int as count from tickets t join contacts c on c.id = t.contact_id
        where t.company_id = ${companyId} and t.created_at >= ${F} and t.created_at < ${T}
        group by c.id, c.first_name, c.last_name order by count(*) desc limit 5`,
  );
  const resolvedList = await rows<{ ticketNumber: string; title: string; resolvedAt: string; minutes: number }>(
    db,
    sql`select t.ticket_number as "ticketNumber", t.title, t.resolved_at as "resolvedAt",
          (select coalesce(sum(te.duration_minutes), 0)::int from time_entries te where te.ticket_id = t.id and te.status in ('submitted','approved','billed')) as minutes
        from tickets t where t.company_id = ${companyId} and t.resolved_at >= ${F} and t.resolved_at < ${T}
        order by t.resolved_at limit 30`,
  );
  const openList = await rows<{ ticketNumber: string; title: string; status: string; createdAt: string }>(
    db,
    sql`select t.ticket_number as "ticketNumber", t.title, st.name as status, t.created_at as "createdAt"
        from tickets t join ticket_statuses st on st.id = t.status_id
        where t.company_id = ${companyId} and t.created_at < ${T} and (t.resolved_at is null or t.resolved_at >= ${T})
        order by t.created_at limit 15`,
  );

  const counted = sql`te.status in ('submitted','approved','billed')`;
  const [w] = await rows<{ minutes: unknown; prev: unknown }>(
    db,
    sql`select coalesce(sum(duration_minutes) filter (where started_at >= ${F} and started_at < ${T}), 0) as minutes,
               coalesce(sum(duration_minutes) filter (where started_at >= ${P} and started_at < ${F}), 0) as prev
        from time_entries te where te.company_id = ${companyId} and ${counted}`,
  );
  const byType = await rows<{ name: string | null; minutes: number }>(
    db,
    sql`select wt.name, sum(te.duration_minutes)::int as minutes from time_entries te left join work_types wt on wt.id = te.work_type_id
        where te.company_id = ${companyId} and ${counted} and te.started_at >= ${F} and te.started_at < ${T}
        group by wt.name order by sum(te.duration_minutes) desc limit 6`,
  );
  const trend = await rows<{ month: string; minutes: number }>(
    db,
    sql`select to_char(m, 'YYYY-MM') as month,
          (select coalesce(sum(te.duration_minutes), 0)::int from time_entries te
            where te.company_id = ${companyId} and ${counted}
              and te.started_at >= (m::timestamp at time zone ${tz}) and te.started_at < ((m + interval '1 month')::timestamp at time zone ${tz})) as minutes
        from generate_series(${from}::date - interval '5 months', ${from}::date, interval '1 month') m order by m`,
  );

  const devicesByType = await rows<{ name: string; count: number }>(
    db,
    sql`select ct.name, count(*)::int as count from configuration_items ci join ci_types ct on ct.id = ci.ci_type_id
        where ci.company_id = ${companyId} and ci.lifecycle_status = 'active' group by ct.name order by count(*) desc`,
  );
  const [dv] = await rows<{ added: unknown }>(
    db,
    sql`select count(*) filter (where created_at >= ${F} and created_at < ${T}) as added from configuration_items where company_id = ${companyId}`,
  );
  const warrantySoon = await rows<{ name: string; typeName: string; date: string }>(
    db,
    sql`select ci.name, ct.name as "typeName", to_char(ci.warranty_expires_at, 'YYYY-MM-DD') as date
        from configuration_items ci join ci_types ct on ct.id = ci.ci_type_id
        where ci.company_id = ${companyId} and ci.lifecycle_status = 'active'
          and ci.warranty_expires_at between ${to}::date - interval '30 days' and ${to}::date + interval '90 days'
        order by ci.warranty_expires_at limit 10`,
  );

  const security = await securitySnapshot(db, companyId);
  const opened = num(t?.opened);
  const resolved = num(t?.resolved);
  const slaTotal = num(t?.sla_total);
  const slaMetPct = pct(num(t?.sla_met), slaTotal);
  const health = healthScore([
    ...securityHealthParts(security),
    slaMetPct == null ? null : { key: 'sla', score: slaMetPct, weight: 25 },
    opened || resolved ? { key: 'resolution', score: Math.min(100, Math.round((resolved / Math.max(opened, 1)) * 100)), weight: 20 } : null,
  ]);

  return {
    version: 1,
    period,
    from,
    to,
    generatedAt: new Date().toISOString(),
    tickets: {
      opened,
      resolved,
      openAtEnd: num(t?.open_at_end),
      prevOpened: num(t?.prev_opened),
      prevResolved: num(t?.prev_resolved),
      avgResolutionHours: t?.avg_hours == null ? null : Math.round(Number(t.avg_hours) * 10) / 10,
      slaMetPct,
      byPriority,
      byCategory,
      topRequesters,
      resolvedList,
      openList,
    },
    work: { minutes: num(w?.minutes), prevMinutes: num(w?.prev), byType, trend },
    devices: { total: devicesByType.reduce((a, d) => a + d.count, 0), byType: devicesByType, added: num(dv?.added), warrantySoon },
    security,
    health,
  };
}
export type ReportData = Awaited<ReturnType<typeof buildReportData>>;

export function reportTitle(period: string, settings: SystemSettings) {
  const t = mailTranslator(mailLang(settings.language));
  return `${t('reportHeading')} — ${monthLabel(period, settings.language)}`;
}

/** Creates the report of a month, or refreshes the figures of a draft. Published reports are left alone unless `refreshPublished`. */
export async function generateReport(
  db: Db,
  o: { companyId: number; period: string; userId: number | null; source: 'auto' | 'manual'; refreshPublished?: boolean },
) {
  const settings = await getSystemSettings(db);
  const [existing] = await db.select().from(s.clientReports).where(and(eq(s.clientReports.companyId, o.companyId), eq(s.clientReports.period, o.period)));
  if (existing && existing.status === 'published' && !o.refreshPublished) return { report: existing, created: false };
  const data = await buildReportData(db, o.companyId, o.period, settings.timezone);
  if (existing) {
    const [row] = await db.update(s.clientReports).set({ data, updatedAt: new Date() }).where(eq(s.clientReports.id, existing.id)).returning();
    return { report: row!, created: false };
  }
  const [row] = await db
    .insert(s.clientReports)
    .values({ companyId: o.companyId, period: o.period, title: reportTitle(o.period, settings), data, source: o.source, createdById: o.userId })
    .returning();
  return { report: row!, created: true };
}

export async function publishReport(db: Db, id: number, userId: number | null, notify: boolean) {
  const [row] = await db
    .update(s.clientReports)
    .set({ status: 'published', publishedAt: new Date(), publishedById: userId, ...(notify ? { emailedAt: null } : {}), updatedAt: new Date() })
    .where(eq(s.clientReports.id, id))
    .returning();
  if (row && notify) await enqueue(db, 'email.report_published', { reportId: row.id }, { maxAttempts: 3 });
  return row ?? null;
}

/** Companies that get automatic reports: an active contract or at least one contact with portal access. */
export async function reportCompanies(db: Tx) {
  return db
    .select({ id: s.companies.id, name: s.companies.name })
    .from(s.companies)
    .where(
      and(
        eq(s.companies.isActive, true),
        or(
          sql`exists (select 1 from contracts c where c.company_id = ${s.companies.id} and c.status = 'active')`,
          sql`exists (select 1 from contacts ct where ct.company_id = ${s.companies.id} and ct.portal_enabled and ct.is_active)`,
        ),
      ),
    )
    .orderBy(s.companies.name);
}

const AUTO_KEY = 'reports_auto';

/** The month to prepare when automatic reports are due (once per month, on or after the configured day). */
export async function monthlyReportsDue(db: Tx, settings: SystemSettings): Promise<string | null> {
  if (settings.reportsAutoMode === 'off') return null;
  if (localParts(settings.timezone, new Date()).day < settings.reportsAutoDay) return null;
  const period = previousPeriod(settings.timezone);
  const [row] = await db.select().from(s.systemSettings).where(eq(s.systemSettings.key, AUTO_KEY));
  return (row?.value as { lastPeriod?: string } | undefined)?.lastPeriod === period ? null : period;
}

/** Prepares (and, in "publish" mode, publishes and e-mails) last month's reports. Existing reports are kept. */
export async function runMonthlyReports(db: Db, _config: Config, period: string) {
  const settings = await getSystemSettings(db);
  const result = { period, created: 0, published: 0 };
  if (!isPeriod(period) || settings.reportsAutoMode === 'off') return result;
  for (const co of await reportCompanies(db)) {
    const { report, created } = await generateReport(db, { companyId: co.id, period, userId: null, source: 'auto' });
    if (!created) continue;
    result.created++;
    if (settings.reportsAutoMode === 'publish') {
      await publishReport(db, report.id, null, true);
      result.published++;
    }
  }
  const value = { lastPeriod: period, ranAt: new Date().toISOString(), ...result };
  await db.insert(s.systemSettings).values({ key: AUTO_KEY, value }).onConflictDoUpdate({ target: s.systemSettings.key, set: { value } });
  return result;
}

export async function lastAutoRun(db: Tx) {
  const [row] = await db.select().from(s.systemSettings).where(eq(s.systemSettings.key, AUTO_KEY));
  return (row?.value as { lastPeriod?: string; ranAt?: string; created?: number; published?: number } | undefined) ?? null;
}

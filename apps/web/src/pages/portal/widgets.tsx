import type { ReactNode } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Clock, HardDrive, Inbox, RotateCcw, ShieldCheck, Timer, Wifi } from 'lucide-react';
import { getLanguage, translate as t } from '@/lib/i18n';
import { cn, fmtDate } from '@/lib/utils';
import { Card, CardBody, CardHeader } from '@/components/ui/misc';
import { BarList, ColumnChart, Donut } from '@/components/charts';
import { Markdown } from '@/components/kb/markdown';
import { fmtMinutes, HEALTH_COLOR, HEALTH_LABEL, HEALTH_PART_LABEL, monthName, type Health } from './lib';

/* ------------------------------------------------------------ health gauge */

/** Half-circle gauge with the 0–100 IT health score. */
export function HealthGauge({ health, size = 180 }: { health: Health | null | undefined; size?: number }) {
  const score = health?.score ?? null;
  const color = health?.grade ? HEALTH_COLOR[health.grade] : 'var(--subtle)';
  const stroke = 14;
  const r = (size - stroke) / 2;
  const half = Math.PI * r;
  const filled = score == null ? 0 : (score / 100) * half;
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size / 2 + stroke} viewBox={`0 0 ${size} ${size / 2 + stroke}`} role="img" aria-label={score == null ? t('No data yet') : `${score}/100`}>
        <path d={`M ${stroke / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${size / 2}`} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} strokeLinecap="round" />
        {score != null && (
          <path
            d={`M ${stroke / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${size / 2}`}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${half}`}
            style={{ transition: 'stroke-dasharray .8s ease' }}
          />
        )}
        <text x="50%" y={size / 2 - 4} textAnchor="middle" className="fill-foreground" style={{ fontSize: size / 5, fontWeight: 700 }}>
          {score ?? '—'}
        </text>
        <text x="50%" y={size / 2 + 14} textAnchor="middle" className="fill-muted" style={{ fontSize: 11 }}>
          / 100
        </text>
      </svg>
      <span className="mt-1 rounded-full px-2.5 py-0.5 text-[12px] font-semibold" style={{ color, backgroundColor: health?.grade ? `${color}1a` : undefined }}>
        {health?.grade ? t(HEALTH_LABEL[health.grade]) : t('No data yet')}
      </span>
    </div>
  );
}

export function HealthParts({ health }: { health: Health | null | undefined }) {
  if (!health?.parts.length) return null;
  return (
    <ul className="space-y-2">
      {health.parts.map((p) => {
        const color = p.score >= 85 ? '#16a34a' : p.score >= 70 ? '#2563eb' : p.score >= 50 ? '#d97706' : '#dc2626';
        return (
          <li key={p.key}>
            <div className="flex justify-between text-[12px]">
              <span>{t(HEALTH_PART_LABEL[p.key] ?? p.key)}</span>
              <span className="font-medium tabular-nums">{p.score}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full" style={{ width: `${p.score}%`, backgroundColor: color }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------- stat tiles */

export function Stat({ icon, label, value, delta, hint, tone }: { icon: ReactNode; label: string; value: ReactNode; delta?: number | null; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3.5">
      <div className="flex items-center gap-1.5 text-[12px] text-muted">
        <span className={tone === 'bad' ? 'text-warning' : tone === 'good' ? 'text-success' : 'text-primary'}>{icon}</span>
        {t(label)}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {delta != null && delta !== 0 && (
          <span className="inline-flex items-center rounded bg-surface-2 px-1 text-[11px] font-medium text-muted">
            {delta > 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {delta > 0 ? '+' : '−'}
            {Math.abs(delta)}
          </span>
        )}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{t(hint)}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ report view */

export interface ReportData {
  period: string;
  generatedAt: string;
  tickets?: {
    opened: number;
    resolved: number;
    openAtEnd: number;
    prevOpened: number;
    prevResolved: number;
    avgResolutionHours: number | null;
    slaMetPct: number | null;
    byPriority: { name: string; color: string | null; count: number }[];
    byCategory: { name: string | null; count: number }[];
    topRequesters: { name: string; count: number }[];
    resolvedList: { ticketNumber: string; title: string; resolvedAt: string; minutes: number }[];
    openList: { ticketNumber: string; title: string; status: string; createdAt: string }[];
  };
  work?: { minutes: number; prevMinutes: number; byType: { name: string | null; minutes: number }[]; trend: { month: string; minutes: number }[] };
  devices?: { total: number; byType: { name: string; count: number }[]; added: number; warrantySoon: { name: string; typeName: string; date: string }[] };
  security?: {
    endpoints: number;
    online: number;
    seenRecently: number;
    rebootRequired: number;
    withCriticalUpdates: number;
    missingCritical: number;
    missingOther: number;
    upToDate: number;
    patchedPct: number | null;
    fullyPatchedPct: number | null;
    os: { name: string; count: number }[];
    attention: { name: string; missingCritical: number; missingOther: number; rebootRequired: boolean; lastSeenAt: string | null }[];
    lastSyncAt: string | null;
  } | null;
  health?: Health;
}

const hoursText = (h: number | null | undefined) => (h == null ? '—' : h < 24 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} ${t('days')}`);

export function ReportView({ title, period, summary, data, companyName, showTime = true }: { title: string; period: string; summary?: string; data: ReportData; companyName?: string; showTime?: boolean }) {
  const lang = getLanguage();
  const tk = data.tickets;
  const work = showTime ? data.work : undefined;
  const sec = data.security;
  const dev = data.devices;
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="grid gap-6 p-5 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="text-[12px] font-medium uppercase tracking-wide text-primary">{monthName(period, lang)}</div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">{title}</h1>
            {companyName && <div className="mt-0.5 text-[13px] text-muted">{companyName}</div>}
            {summary?.trim() && (
              <div className="mt-4 rounded-lg border-l-4 border-primary bg-primary-soft/40 px-4 py-3 text-[13px]">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-primary">{t('Message from your IT team')}</div>
                <Markdown source={summary} />
              </div>
            )}
          </div>
          {data.health && (
            <div className="flex flex-col items-center gap-3 md:w-64">
              <div className="text-[12px] font-medium text-muted">{t('IT health score')}</div>
              <HealthGauge health={data.health} size={170} />
              <div className="w-full">
                <HealthParts health={data.health} />
              </div>
            </div>
          )}
        </div>
      </Card>

      {tk && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={<Inbox className="size-4" />} label="Requests opened" value={tk.opened} delta={tk.opened - tk.prevOpened} hint="Compared with the month before" />
          <Stat icon={<CheckCircle2 className="size-4" />} label="Requests resolved" value={tk.resolved} tone="good" />
          <Stat icon={<Timer className="size-4" />} label="Average resolution time" value={hoursText(tk.avgResolutionHours)} />
          <Stat icon={<ShieldCheck className="size-4" />} label="Response times met" value={tk.slaMetPct == null ? '—' : `${tk.slaMetPct}%`} tone={tk.slaMetPct != null && tk.slaMetPct < 80 ? 'bad' : 'good'} />
        </div>
      )}

      {tk && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Requests by urgency" />
            <CardBody>
              <BarList data={tk.byPriority.map((p) => ({ label: p.name, value: p.count, color: p.color }))} emptyLabel={t('No requests this month')} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="What the requests were about" />
            <CardBody>
              <BarList data={tk.byCategory.map((p) => ({ label: p.name ?? t('Other'), value: p.count }))} emptyLabel={t('No requests this month')} />
            </CardBody>
          </Card>
        </div>
      )}

      {work && (
        <Card>
          <CardHeader title="Time spent for you" actions={<span className="text-[13px] font-semibold">{fmtMinutes(work.minutes)}</span>} />
          <CardBody className="grid gap-6 md:grid-cols-[2fr_1fr]">
            <ColumnChart
              height={150}
              data={work.trend.map((m) => ({ x: monthName(m.month, lang, true), values: { hours: Math.round((m.minutes / 60) * 10) / 10 } }))}
              series={[{ key: 'hours', label: t('Hours'), color: '#6366f1' }]}
            />
            <BarList data={work.byType.map((w) => ({ label: w.name ?? t('Other'), value: w.minutes }))} format={(n) => fmtMinutes(n)} emptyLabel={t('No time this month')} />
          </CardBody>
        </Card>
      )}

      {sec && (
        <Card>
          <CardHeader title="Security updates and device health" actions={sec.lastSyncAt ? <span className="text-[11px] text-muted">{t('Updated {when}', { when: fmtDate(sec.lastSyncAt) })}</span> : null} />
          <CardBody className="grid gap-6 md:grid-cols-[auto_1fr]">
            <Donut
              size={140}
              data={[
                { label: t('Up to date'), value: sec.upToDate, color: '#16a34a' },
                { label: t('Minor updates pending'), value: Math.max(0, sec.endpoints - sec.upToDate - sec.withCriticalUpdates), color: '#f59e0b' },
                { label: t('Critical updates missing'), value: sec.withCriticalUpdates, color: '#dc2626' },
              ]}
              center={
                <div className="text-center">
                  <div className="text-xl font-bold">{sec.patchedPct ?? 0}%</div>
                  <div className="text-[10px] text-muted">{t('protected')}</div>
                </div>
              }
            />
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MiniStat icon={<HardDrive className="size-3.5" />} label="Managed devices" value={sec.endpoints} />
                <MiniStat icon={<Wifi className="size-3.5" />} label="Seen in the last 30 days" value={sec.seenRecently} />
                <MiniStat icon={<RotateCcw className="size-3.5" />} label="Restart pending" value={sec.rebootRequired} warn={sec.rebootRequired > 0} />
                <MiniStat icon={<AlertTriangle className="size-3.5" />} label="Critical updates missing" value={sec.missingCritical} warn={sec.missingCritical > 0} />
              </div>
              {sec.attention.length > 0 && (
                <div>
                  <div className="mb-1 text-[12px] font-medium">{t('Devices that need attention')}</div>
                  <ul className="divide-y divide-border rounded-md border border-border text-[12px]">
                    {sec.attention.map((a) => (
                      <li key={a.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5">
                        <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                        {a.missingCritical > 0 && <span className="text-danger">{t('{n} critical updates', { n: a.missingCritical })}</span>}
                        {a.rebootRequired && <span className="text-warning">{t('restart needed')}</span>}
                        {a.lastSeenAt && <span className="text-muted">{t('last seen {date}', { date: fmtDate(a.lastSeenAt) })}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {dev && (
        <Card>
          <CardHeader title="Your equipment" actions={<span className="text-[13px] font-semibold">{t('{n} devices', { n: dev.total })}</span>} />
          <CardBody className="grid gap-6 md:grid-cols-2">
            <BarList data={dev.byType.map((d) => ({ label: d.name, value: d.count }))} emptyLabel={t('No devices recorded')} />
            <div>
              <div className="mb-1 text-[12px] font-medium">{t('Warranties ending soon')}</div>
              {dev.warrantySoon.length ? (
                <ul className="space-y-1 text-[12px]">
                  {dev.warrantySoon.map((w) => (
                    <li key={w.name} className="flex justify-between gap-2">
                      <span className="truncate">
                        {w.name} <span className="text-muted">· {w.typeName}</span>
                      </span>
                      <span className="shrink-0 text-warning">{fmtDate(w.date)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-muted">{t('No warranty ends in the next three months.')}</p>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {tk && (tk.resolvedList.length > 0 || tk.openList.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Resolved this month" />
            <ul className="divide-y divide-border text-[12px]">
              {tk.resolvedList.map((r) => (
                <li key={r.ticketNumber} className="flex items-center gap-2 px-4 py-2">
                  <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  {showTime && r.minutes > 0 && <span className="shrink-0 text-muted">{fmtMinutes(r.minutes)}</span>}
                </li>
              ))}
              {!tk.resolvedList.length && <li className="px-4 py-3 text-muted">{t('Nothing resolved this month.')}</li>}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Still in progress" />
            <ul className="divide-y divide-border text-[12px]">
              {tk.openList.map((r) => (
                <li key={r.ticketNumber} className="flex items-center gap-2 px-4 py-2">
                  <Clock className="size-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className="shrink-0 text-muted">{r.status}</span>
                </li>
              ))}
              {!tk.openList.length && <li className="px-4 py-3 text-muted">{t('Everything is resolved.')}</li>}
            </ul>
          </Card>
        </div>
      )}
      <p className="text-center text-[11px] text-subtle">{t('Figures as of {date}', { date: fmtDate(data.generatedAt) })}</p>
    </div>
  );
}

function MiniStat({ icon, label, value, warn }: { icon: ReactNode; label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-md bg-surface-2 px-2.5 py-2">
      <div className={cn('flex items-center gap-1 text-[11px]', warn ? 'text-warning' : 'text-muted')}>
        {icon} {t(label)}
      </div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

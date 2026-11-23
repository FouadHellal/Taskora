import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, FileSignature } from 'lucide-react';
import { CONTRACT_TYPE } from '@taskora/shared';
import { getLanguage, translate as t } from '@/lib/i18n';
import { cn, fmtDate } from '@/lib/utils';
import { Card, CardBody, CardHeader, EmptyState, PageLoader } from '@/components/ui/misc';
import { ColumnChart, Progress } from '@/components/charts';
import { fmtMinutes, papi, type Me } from './lib';

interface Work {
  months: { month: string; minutes: number; tickets: number }[];
  entries: { id: number; startedAt: string; minutes: number; description: string; technician: string | null; ticketId: number; ticketNumber: string; ticketTitle: string }[];
  contracts: {
    id: number;
    name: string;
    contractNumber: string;
    type: string;
    startDate: string | null;
    endDate: string | null;
    purchasedHours: number;
    usedHours: number;
    remainingHours: number;
    lowBalance: boolean;
    blocks: { id: number; hours: number; usedHours: number; remainingHours: number; startDate: string | null; endDate: string | null; expired: boolean }[];
  }[];
  month: string | null;
}

/** The last 12 months, oldest first ("2026-11"). */
function lastMonths(n = 12) {
  const out: string[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const monthLabel = (m: string, long = false) => new Date(`${m}-01T12:00:00`).toLocaleDateString(getLanguage(), long ? { month: 'long', year: 'numeric' } : { month: 'short' });

const CONTRACT_TYPES = CONTRACT_TYPE.labels as Record<string, string>;

export default function PortalWork({ me }: { me: Me }) {
  const [month, setMonth] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['portal-work', month], queryFn: () => papi<Work>('GET', `/work${month ? `?month=${month}` : ''}`) });
  const c = me.contact!;
  if (q.isLoading && !q.data) return <PageLoader />;
  const w = q.data;
  const byMonth = new Map((w?.months ?? []).map((m) => [m.month, m]));
  const months = lastMonths();
  const thisMonth = months[months.length - 1]!;
  const total12 = (w?.months ?? []).reduce((a, m) => a + m.minutes, 0);
  const listTotal = (w?.entries ?? []).reduce((a, e) => a + e.minutes, 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('Work & hours')}</h1>
        <p className="text-[12px] text-muted">{c.isManager ? t('Time the IT team spent on the tickets of {company}.', { company: c.companyName }) : t('Time the IT team spent on your tickets.')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Card className="p-4">
          <div className="text-[12px] text-muted">{t('This month')}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtMinutes(byMonth.get(thisMonth)?.minutes ?? 0)}</div>
          <div className="text-[11px] text-muted">{t('{n} tickets', { n: byMonth.get(thisMonth)?.tickets ?? 0 })}</div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] text-muted">{t('Last 12 months')}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtMinutes(total12)}</div>
          <div className="text-[11px] text-muted">{t('about {time} per month', { time: fmtMinutes(Math.round(total12 / 12)) })}</div>
        </Card>
        {w?.contracts.some((x) => x.purchasedHours > 0) && (
          <Card className="col-span-2 p-4 lg:col-span-1">
            <div className="text-[12px] text-muted">{t('Hours left in your contracts')}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{w.contracts.reduce((a, x) => a + x.remainingHours, 0).toFixed(1)} h</div>
            <div className="text-[11px] text-muted">{t('of {n} h purchased', { n: w.contracts.reduce((a, x) => a + x.purchasedHours, 0).toFixed(1) })}</div>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader title="Hours per month" description="Click a month to see the details." />
        <CardBody>
          <ColumnChart
            height={150}
            data={months.map((m) => ({ x: monthLabel(m), values: { hours: Math.round(((byMonth.get(m)?.minutes ?? 0) / 60) * 10) / 10 } }))}
            series={[{ key: 'hours', label: t('Hours'), color: '#6366f1' }]}
          />
          <div className="mt-3 flex flex-wrap gap-1">
            <button onClick={() => setMonth(null)} className={cn('cursor-pointer rounded-md border px-2 py-1 text-[11px]', month === null ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-foreground')}>
              {t('Last 90 days')}
            </button>
            {[...months].reverse().filter((m) => (byMonth.get(m)?.minutes ?? 0) > 0 || m === month).map((m) => (
              <button
                key={m}
                onClick={() => setMonth(m)}
                className={cn('cursor-pointer rounded-md border px-2 py-1 text-[11px]', month === m ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-foreground')}
              >
                {monthLabel(m, true)} · {fmtMinutes(byMonth.get(m)?.minutes ?? 0)}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={month ? t('Work in {month}', { month: monthLabel(month, true) }) : 'Work in the last 90 days'} actions={<span className="text-[12px] font-medium">{t('Total: {time}', { time: fmtMinutes(listTotal) })}</span>} />
        {!w?.entries.length ? (
          <EmptyState icon={<Clock />} title="No work recorded in this period" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2 font-medium">{t('Date')}</th>
                  <th className="px-2 py-2 font-medium">{t('Ticket')}</th>
                  <th className="px-2 py-2 font-medium">{t('Work done')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('Time')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {w.entries.map((e) => (
                  <tr key={e.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-[12px] text-muted">{fmtDate(e.startedAt)}</td>
                    <td className="px-2 py-2">
                      <Link to={`/portal/tickets/${e.ticketId}`} className="text-primary hover:underline">
                        <span className="font-mono text-[11px]">{e.ticketNumber}</span>
                      </Link>
                      <div className="max-w-56 truncate text-[12px] text-muted">{e.ticketTitle}</div>
                    </td>
                    <td className="px-2 py-2">
                      <div className="whitespace-pre-wrap break-words">{e.description}</div>
                      {e.technician && <div className="text-[11px] text-muted">{e.technician}</div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums">{fmtMinutes(e.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {me.features?.contracts && (
        <Card>
          <CardHeader title="Contracts" />
          {!w?.contracts.length ? (
            <CardBody className="text-[13px] text-muted">{t('No active contract.')}</CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {w.contracts.map((ct) => (
                <li key={ct.id} className="space-y-2 px-4 py-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <FileSignature className="size-4 text-primary" />
                    <span className="font-medium">{ct.name}</span>
                    <span className="text-[11px] text-muted">
                      {t(CONTRACT_TYPES[ct.type] ?? ct.type)} · {ct.startDate ? fmtDate(ct.startDate) : '—'} → {ct.endDate ? fmtDate(ct.endDate) : t('no end date')}
                    </span>
                    {ct.lowBalance && (
                      <span className="inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 py-px text-[11px] text-warning">
                        <AlertTriangle className="size-3" /> {t('Few hours left')}
                      </span>
                    )}
                  </div>
                  {ct.purchasedHours > 0 ? (
                    <div>
                      <div className="mb-1 flex justify-between text-[12px] text-muted">
                        <span>{t('{used} h used of {total} h', { used: ct.usedHours.toFixed(1), total: ct.purchasedHours.toFixed(1) })}</span>
                        <span className="font-medium text-foreground">{t('{n} h left', { n: ct.remainingHours.toFixed(1) })}</span>
                      </div>
                      <Progress value={ct.purchasedHours ? (ct.usedHours / ct.purchasedHours) * 100 : 0} tone={ct.lowBalance ? 'warning' : 'primary'} />
                    </div>
                  ) : (
                    <div className="text-[12px] text-muted">{t('{n} h recorded on this contract', { n: ct.usedHours.toFixed(1) })}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

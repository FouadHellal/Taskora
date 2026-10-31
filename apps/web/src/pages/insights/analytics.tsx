import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { formatMinutes } from '@taskora/shared';
import { api } from '@/lib/api';
import { opts, useLookups, userOpts } from '@/lib/lookups';
import { PageHeader, FilterSelect } from '@/components/page';
import { Card, CardBody, CardHeader, PageLoader, Stat } from '@/components/ui/misc';
import { BarList, ColumnChart, Donut, CHART_COLORS } from '@/components/charts';
import { EntityPicker } from '@/components/entity-picker';
import { DateRangeFilter, defaultRange, fmtNum, type DateRange } from '@/components/insights/filters';

type Row = Record<string, string | number>;

export default function AnalyticsPage() {
  const lookups = useLookups();
  const [range, setRange] = useState<DateRange>(defaultRange());
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [queueId, setQueueId] = useState('');
  const [userId, setUserId] = useState('');
  const base = { from: range.from, to: range.to, companyId: companyId ?? undefined, userId: userId || undefined };
  const dash = useQuery({ queryKey: ['analytics-dash', base, queueId], queryFn: () => api.get<any>('/dashboard', { ...base, queueId: queueId || undefined }), placeholderData: keepPreviousData });
  const get = (path: string, group: string) => api.get<{ data: Row[] }>(path, { ...base, group }).then((r) => r.data);
  const workTypes = useQuery({ queryKey: ['analytics', 'time-wt', base], queryFn: () => get('/reports/time', 'workType'), placeholderData: keepPreviousData });
  const byTech = useQuery({ queryKey: ['analytics', 'time-user', base], queryFn: () => get('/reports/time', 'user'), placeholderData: keepPreviousData });
  const sla = useQuery({ queryKey: ['analytics', 'sla', base], queryFn: () => get('/reports/sla', 'priority'), placeholderData: keepPreviousData });
  const issues = useQuery({ queryKey: ['analytics', 'issues', base], queryFn: () => get('/reports/tickets', 'issue'), placeholderData: keepPreviousData });
  const companies = useQuery({ queryKey: ['analytics', 'companies', base], queryFn: () => get('/reports/tickets', 'company'), placeholderData: keepPreviousData });
  const os = useQuery({ queryKey: ['analytics', 'os', companyId], queryFn: () => api.get<{ data: Row[] }>('/reports/assets', { group: 'os', companyId: companyId ?? undefined }).then((r) => r.data) });
  const d = dash.data;
  const sum = (rows: Row[] | undefined, k: string) => (rows ?? []).reduce((a, r) => a + Number(r[k] ?? 0), 0);

  return (
    <div>
      <PageHeader title="Analytics" icon={<Activity />} subtitle="Trends across service delivery, effort and assets">
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <DateRangeFilter value={range} onChange={setRange} />
          <div className="w-52">
            <EntityPicker kind="company" value={companyId} onChange={setCompanyId} placeholder="All companies" />
          </div>
          <FilterSelect value={queueId} onChange={setQueueId} placeholder="All queues" options={opts(lookups.data?.queues)} />
          <FilterSelect value={userId} onChange={setUserId} placeholder="All technicians" options={userOpts(lookups.data?.users)} />
        </div>
      </PageHeader>
      {!d ? (
        <PageLoader />
      ) : (
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Created" value={d.kpi.created} />
            <Stat label="Resolved" value={d.kpi.resolved} />
            <Stat label="SLA compliance" value={`${d.kpi.slaCompliance}%`} tone={d.kpi.slaCompliance >= 90 ? 'success' : d.kpi.slaCompliance >= 75 ? 'warning' : 'danger'} />
            <Stat label="Avg first response" value={formatMinutes(d.kpi.avgFirstResponseMinutes)} />
            <Stat label="Hours logged" value={fmtNum(sum(byTech.data, 'hours'), 1)} hint={`${fmtNum(sum(byTech.data, 'billableHours'), 1)} h billable`} />
            <Stat label="Billable amount" value={fmtNum(sum(byTech.data, 'billableAmount'), 0)} />
          </div>
          <Card>
            <CardHeader title="Created vs resolved" />
            <CardBody>
              <ColumnChart
                data={d.trend.map((t: { day: string; created: number; resolved: number }) => ({ x: t.day, values: { created: t.created, resolved: t.resolved } }))}
                series={[
                  { key: 'created', label: 'Created', color: 'var(--primary)' },
                  { key: 'resolved', label: 'Resolved', color: 'var(--success)' },
                ]}
              />
            </CardBody>
          </Card>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Open by status" />
              <CardBody>
                <Donut data={d.byStatus.map((s: { name: string; count: number; color: string }) => ({ label: s.name, value: s.count, color: s.color }))} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Hours by work type" />
              <CardBody>
                <Donut data={(workTypes.data ?? []).map((r, i) => ({ label: String(r.group), value: Math.round(Number(r.hours)), color: CHART_COLORS[i % CHART_COLORS.length] }))} center={<span className="text-sm font-semibold">{fmtNum(sum(workTypes.data, 'hours'), 0)} h</span>} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="SLA compliance by priority" />
              <CardBody>
                <BarList data={(sla.data ?? []).map((r) => ({ label: String(r.group), value: Number(r.resolutionCompliance), color: Number(r.resolutionCompliance) >= 90 ? 'var(--success)' : 'var(--warning)' }))} max={100} format={(n) => `${n}%`} />
              </CardBody>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Technician effort" description="Billable, contract-covered and non-billable hours" />
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                      <th className="px-4 py-2">Technician</th>
                      <th className="px-4 py-2 text-right">Total</th>
                      <th className="px-4 py-2 text-right">Billable</th>
                      <th className="px-4 py-2 text-right">Contract</th>
                      <th className="px-4 py-2 text-right">Non-billable</th>
                      <th className="px-4 py-2 text-right">Open tickets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(byTech.data ?? []).map((r) => (
                      <tr key={String(r.group)} className="border-t border-border">
                        <td className="px-4 py-1.5">{r.group}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtNum(Number(r.hours), 1)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtNum(Number(r.billableHours), 1)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtNum(Number(r.contractHours), 1)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtNum(Number(r.nonBillableHours), 1)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{d.workload.find((w: { name: string }) => w.name === r.group)?.openTickets ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <CardHeader title="Top issue types" />
              <CardBody>
                <BarList data={(issues.data ?? []).slice(0, 10).map((r) => ({ label: String(r.group), value: Number(r.created) }))} />
              </CardBody>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Busiest companies" description="Tickets created in period" />
              <CardBody>
                <BarList data={(companies.data ?? []).slice(0, 10).map((r) => ({ label: String(r.group), value: Number(r.created) }))} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Operating systems" />
              <CardBody>
                <BarList data={(os.data ?? []).slice(0, 10).map((r) => ({ label: String(r.group), value: Number(r.total) }))} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Endpoint health (Action1)" />
              <CardBody className="space-y-2 text-[13px]">
                {[
                  ['Synced endpoints', d.assets.syncedEndpoints],
                  ['Needing attention', d.assets.devicesAttention],
                  ['Awaiting review', d.assets.endpointsNeedReview],
                  ['Warranties expiring (60 d)', d.assets.warrantyExpiring],
                ].map(([label, v]) => (
                  <div key={String(label)} className="flex justify-between">
                    <span className="text-muted">{label}</span>
                    <span className="font-semibold tabular-nums">{v}</span>
                  </div>
                ))}
                <p className="pt-2 text-xs text-muted">Integration: {d.integration?.enabled ? d.integration.status : 'disabled'}</p>
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

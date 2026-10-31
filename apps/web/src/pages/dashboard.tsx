import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, LayoutDashboard, Plug, RotateCcw, ShieldAlert } from 'lucide-react';
import { formatMinutes } from '@taskora/shared';
import { api } from '@/lib/api';
import { opts, useLookups, userOpts } from '@/lib/lookups';
import { fmtRelative } from '@/lib/utils';
import { PageHeader, FilterSelect } from '@/components/page';
import { Card, CardBody, CardHeader, Stat, PageLoader, Badge } from '@/components/ui/misc';
import { BarList, ColumnChart, Donut } from '@/components/charts';
import { EntityPicker } from '@/components/entity-picker';
import { DeviceStateBadge } from '@/components/badges';

interface Dashboard {
  kpi: Record<string, number>;
  time: { minutes: number; billableMinutes: number; coveredMinutes: number };
  assets: Record<string, number>;
  integration: { enabled: boolean; status: string; lastSyncAt: string | null; lastSuccessAt: string | null; lastError: string | null } | null;
  byStatus: { id: number; name: string; color: string; count: number }[];
  byPriority: { id: number; name: string; color: string; count: number }[];
  byQueue: { id: number | null; name: string; count: number }[];
  workload: { id: number; name: string; openTickets: number; highPriority: number; minutes: number }[];
  trend: { day: string; created: number; resolved: number }[];
  attentionDevices: { id: number; name: string; companyName: string; agentStatus: string | null; rebootRequired: boolean | null; missingCriticalUpdates: number | null; lastSeenAt: string | null }[];
}

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

export default function DashboardPage() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const [days, setDays] = useState('30');
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [queueId, setQueueId] = useState('');
  const [userId, setUserId] = useState('');
  const from = new Date(Date.now() - Number(days) * 86400_000).toISOString();
  const q = useQuery({
    queryKey: ['dashboard', days, companyId, queueId, userId],
    queryFn: () => api.get<Dashboard>('/dashboard', { from, companyId, queueId, userId }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const d = q.data;
  const ticketLink = (params: Record<string, string | number>) => `/tickets?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`;

  return (
    <div>
      <PageHeader title="Dashboard" icon={<LayoutDashboard />} subtitle="Operational overview calculated live from the service desk">
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <FilterSelect value={days} onChange={(v) => setDays(v || '30')} options={RANGES} placeholder="Period" />
          <div className="w-52">
            <EntityPicker kind="company" value={companyId} onChange={setCompanyId} placeholder="All companies" />
          </div>
          <FilterSelect value={queueId} onChange={setQueueId} options={opts(lookups.data?.queues)} placeholder="All queues" />
          <FilterSelect value={userId} onChange={setUserId} options={[{ value: 'me', label: 'Me' }, ...userOpts(lookups.data?.users)]} placeholder="All technicians" />
        </div>
      </PageHeader>
      {!d ? (
        <PageLoader />
      ) : (
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Open tickets" value={d.kpi.openTickets} onClick={() => navigate(ticketLink({ statusCategory: 'open' }))} />
            <Stat label="Unassigned" value={d.kpi.unassigned} tone={d.kpi.unassigned ? 'warning' : undefined} onClick={() => navigate('/tickets/unassigned')} />
            <Stat label="Critical" value={d.kpi.critical} tone={d.kpi.critical ? 'danger' : undefined} hint="Open, priority 1" />
            <Stat label="SLA breached" value={d.kpi.slaBreached} tone={d.kpi.slaBreached ? 'danger' : 'success'} onClick={() => navigate('/sla-monitor')} />
            <Stat label="SLA at risk" value={d.kpi.slaAtRisk} tone={d.kpi.slaAtRisk ? 'warning' : undefined} hint="Due within the hour" />
            <Stat label="Awaiting customer" value={d.kpi.waiting} onClick={() => navigate(ticketLink({ statusCategory: 'waiting' }))} />
            <Stat label="Avg first response" value={formatMinutes(d.kpi.avgFirstResponseMinutes)} hint={`${d.kpi.created} created in period`} />
            <Stat label="Avg resolution" value={formatMinutes(d.kpi.avgResolutionMinutes)} hint={`${d.kpi.resolved} resolved · ${d.kpi.slaCompliance}% within SLA`} />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Tickets created vs resolved" description={RANGES.find((r) => r.value === days)?.label} />
              <CardBody>
                <ColumnChart
                  data={d.trend.map((t) => ({ x: t.day, values: { created: t.created, resolved: t.resolved } }))}
                  series={[
                    { key: 'created', label: 'Created', color: 'var(--primary)' },
                    { key: 'resolved', label: 'Resolved', color: 'var(--success)' },
                  ]}
                />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Open tickets by priority" />
              <CardBody>
                <Donut data={d.byPriority.map((p) => ({ label: p.name, value: p.count, color: p.color }))} />
              </CardBody>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader title="By status" />
              <CardBody>
                <BarList data={d.byStatus.map((s) => ({ label: s.name, value: s.count, color: s.color }))} onClick={(x) => navigate(ticketLink({ statusIds: d.byStatus.find((s) => s.name === x.label)!.id, statusCategory: 'all' }))} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Open by queue" />
              <CardBody>
                <BarList data={d.byQueue.map((s) => ({ label: s.name, value: s.count }))} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Time logged" description={`${(d.time.minutes / 60).toFixed(1)} h in period`} />
              <CardBody>
                <BarList
                  data={[
                    { label: 'Billable', value: Math.round(d.time.billableMinutes / 6) / 10, color: 'var(--success)' },
                    { label: 'Contract-covered', value: Math.round(d.time.coveredMinutes / 6) / 10, color: 'var(--info)' },
                    { label: 'Non-billable', value: Math.round((d.time.minutes - d.time.billableMinutes - d.time.coveredMinutes) / 6) / 10, color: 'var(--subtle)' },
                  ]}
                  format={(n) => `${n} h`}
                  max={Math.max(1, d.time.minutes / 60)}
                />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Assets & integration" actions={<Plug className="size-4 text-muted" />} />
              <CardBody className="space-y-2 text-[13px]">
                <Row label="Active companies" value={d.assets.activeCompanies} to="/companies" />
                <Row label="Managed configuration items" value={d.assets.managedCis} to="/assets" />
                <Row label="Action1 endpoints" value={d.assets.syncedEndpoints} to="/integrations/action1/endpoints" />
                <Row label="Devices needing attention" value={d.assets.devicesAttention} to="/assets/devices?attention=true" tone={d.assets.devicesAttention ? 'text-danger' : undefined} />
                <Row label="Endpoints to review" value={d.assets.endpointsNeedReview} to="/integrations/action1/endpoints" tone={d.assets.endpointsNeedReview ? 'text-warning' : undefined} />
                <Row label="Warranties expiring (60 d)" value={d.assets.warrantyExpiring} to="/assets?warranty=expiring" />
                <div className="border-t border-border pt-2 text-xs text-muted">
                  Action1 sync:{' '}
                  {!d.integration?.enabled ? (
                    <span>disabled</span>
                  ) : d.integration.status === 'ok' ? (
                    <Badge tone="success">healthy · {fmtRelative(d.integration.lastSuccessAt)}</Badge>
                  ) : (
                    <Badge tone="danger" title={d.integration.lastError ?? undefined}>
                      {d.integration.status}
                    </Badge>
                  )}
                </div>
              </CardBody>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title="Technician workload" description="Open tickets and hours logged in the period" />
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                      <th className="px-4 py-2 font-semibold">Technician</th>
                      <th className="px-4 py-2 text-right font-semibold">Open</th>
                      <th className="px-4 py-2 text-right font-semibold">High / critical</th>
                      <th className="px-4 py-2 text-right font-semibold">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.workload.map((w) => (
                      <tr key={w.id} className="border-t border-border">
                        <td className="px-4 py-1.5">
                          <Link to={ticketLink({ assignedUserId: w.id, statusCategory: 'open' })} className="hover:text-primary">
                            {w.name}
                          </Link>
                        </td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{w.openTickets}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{w.highPriority ? <span className="font-semibold text-danger">{w.highPriority}</span> : 0}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{(w.minutes / 60).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <CardHeader title="Devices requiring attention" description="From Action1: disconnected, reboot pending or missing critical updates" actions={<AlertTriangle className="size-4 text-warning" />} />
              {d.attentionDevices.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted">All managed devices look healthy.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {d.attentionDevices.map((dev) => (
                    <li key={dev.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                      <Link to={`/assets/${dev.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-primary">
                        {dev.name}
                        <span className="ml-2 text-xs font-normal text-muted">{dev.companyName}</span>
                      </Link>
                      <DeviceStateBadge agentStatus={dev.agentStatus} />
                      {dev.rebootRequired && (
                        <Badge tone="warning">
                          <RotateCcw className="size-3" /> Reboot
                        </Badge>
                      )}
                      {!!dev.missingCriticalUpdates && (
                        <Badge tone="danger">
                          <ShieldAlert className="size-3" /> {dev.missingCriticalUpdates}
                        </Badge>
                      )}
                      <span className="w-20 text-right text-xs text-muted">{fmtRelative(dev.lastSeenAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, to, tone }: { label: string; value: number; to: string; tone?: string }) {
  return (
    <Link to={to} className="flex items-center justify-between hover:text-primary">
      <span className="text-muted">{label}</span>
      <span className={`font-semibold tabular-nums ${tone ?? ''}`}>{value}</span>
    </Link>
  );
}

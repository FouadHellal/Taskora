import { useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLookups } from '@/lib/lookups';
import { cn } from '@/lib/utils';
import { useTableState } from '@/hooks/use-table-state';
import { FilterSelect, PageHeader } from '@/components/page';
import { DataTable, type Column } from '@/components/data-table';
import { SlaBadge } from '@/components/badges';
import { BarList, Progress } from '@/components/charts';
import { Card, CardHeader, EmptyState, Skeleton, Stat } from '@/components/ui/misc';
import { AssignToMeButton, ticketCols, type TicketRow } from '@/components/workspace/tickets';
import { defaultRange } from '@/components/insights/filters';
import { useOpenTicket } from '@/lib/open-ticket';

interface Counts {
  mine: number;
  unassigned: number;
  open: number;
  breached: number;
  waiting: number;
  atRisk: number;
}
interface SlaReportRow {
  group: string;
  tickets: number;
  withFirstResponseTarget: number;
  firstResponseMet: number;
  resolvedWithTarget: number;
  resolutionMet: number;
  resolutionCompliance: number;
}

const TABS = [
  { key: 'breached', label: 'Breached', params: { statusCategory: 'open', slaState: 'breached' } },
  { key: 'at_risk', label: 'At risk', params: { statusCategory: 'open', slaState: 'at_risk' } },
  { key: 'waiting', label: 'Paused (waiting)', params: { statusCategory: 'waiting' } },
  { key: 'all', label: 'All open', params: { statusCategory: 'open' } },
] as const;

const complianceTone = (pct: number) => (pct >= 95 ? 'var(--success)' : pct >= 85 ? 'var(--warning)' : 'var(--danger)');

export default function SlaMonitorPage() {
  const navigate = useNavigate();
  const openTicket = useOpenTicket();
  const { can } = useAuth();
  const lookups = useLookups();
  const t = useTableState({ sort: 'dueAt', order: 'asc', filters: { tab: 'breached' } });
  const tab = TABS.find((x) => x.key === t.filters.tab) ?? TABS[0];
  const range = defaultRange();

  const counts = useQuery({ queryKey: ['tickets', 'counts'], queryFn: () => api.get<Counts>('/tickets/counts'), refetchInterval: 60_000 });
  const dashboard = useQuery({
    queryKey: ['dashboard', 'sla-kpi', range],
    queryFn: () => api.get<{ kpi: { slaCompliance: number; avgFirstResponseMinutes: number; resolved: number } }>('/dashboard', range),
    enabled: can('dashboard.read'),
  });
  const byPriority = useQuery({
    queryKey: ['reports', 'sla', 'priority', range],
    queryFn: () => api.get<{ data: SlaReportRow[] }>('/reports/sla', { group: 'priority', ...range }),
    enabled: can('reports.read'),
  });
  const byQueue = useQuery({
    queryKey: ['reports', 'sla', 'queue', range],
    queryFn: () => api.get<{ data: SlaReportRow[] }>('/reports/sla', { group: 'queue', ...range }),
    enabled: can('reports.read'),
  });

  const { tab: _tab, ...filters } = t.filters;
  void _tab;
  const query = { page: t.page, pageSize: t.pageSize, sort: t.sort, order: t.order, ...filters, ...tab.params };
  const list = useQuery({
    queryKey: ['tickets', 'sla-monitor', query],
    queryFn: () => api.get<Paginated<TicketRow>>('/tickets', query),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const columns: Column<TicketRow>[] = [
    ticketCols.ticket,
    ticketCols.company,
    ticketCols.priority,
    {
      header: 'First response',
      cell: ({ row }) => <SlaBadge state={row.original.sla.firstResponse} due={row.original.firstResponseAt ? null : row.original.firstResponseDueAt} />,
    },
    {
      header: 'Resolution',
      meta: { sortKey: 'dueAt' },
      cell: ({ row }) => <SlaBadge state={row.original.sla.resolution} due={row.original.resolutionDueAt} />,
    },
    ticketCols.assignee,
    ticketCols.queue,
    ticketCols.status,
    ...(can('tickets.write')
      ? [{ id: 'actions', header: '', meta: { align: 'right' as const, className: 'w-20' }, cell: ({ row }: { row: { original: TicketRow } }) => <AssignToMeButton ticket={row.original} /> } as Column<TicketRow>]
      : []),
  ];

  const c = counts.data;
  const tabCount: Record<string, number | undefined> = { breached: c?.breached, at_risk: c?.atRisk, waiting: c?.waiting, all: c?.open };
  const compliance = dashboard.data?.kpi.slaCompliance;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="SLA monitor" subtitle="Live view of tickets against first response and resolution targets" icon={<ShieldAlert />} />
      <div className="grid grid-cols-2 gap-3 border-b border-border bg-surface px-5 py-3 md:grid-cols-4">
        {!c ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[66px]" />)
        ) : (
          <>
            <Stat label="Breached" value={c.breached} tone={c.breached ? 'danger' : 'success'} hint="Open tickets past a target" onClick={() => t.setFilter('tab', 'breached')} />
            <Stat label="At risk" value={c.atRisk} tone={c.atRisk ? 'warning' : undefined} hint="Due within the next hour" onClick={() => t.setFilter('tab', 'at_risk')} />
            <Stat label="Paused / waiting" value={c.waiting} hint="SLA clock paused" onClick={() => t.setFilter('tab', 'waiting')} />
            <Stat
              label="Compliance (30d)"
              value={compliance === undefined ? '—' : `${compliance}%`}
              tone={compliance === undefined ? undefined : compliance >= 95 ? 'success' : compliance >= 85 ? 'warning' : 'danger'}
              hint={dashboard.data ? `${dashboard.data.kpi.resolved} resolved in period` : can('dashboard.read') ? 'Loading…' : 'Requires dashboard access'}
            />
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-surface">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2">
            <div className="inline-flex rounded-md border border-border-strong p-0.5">
              {TABS.map((x) => (
                <button
                  key={x.key}
                  onClick={() => t.setFilter('tab', x.key)}
                  className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium', tab.key === x.key ? 'bg-primary-soft text-primary' : 'text-muted hover:text-foreground')}
                >
                  {x.label}
                  {tabCount[x.key] !== undefined && (
                    <span className={cn('rounded px-1 tabular-nums', x.key === 'breached' && tabCount[x.key] ? 'bg-danger-soft text-danger' : 'bg-surface-2')}>{tabCount[x.key]}</span>
                  )}
                </button>
              ))}
            </div>
            <FilterSelect value={t.filters.queueIds} onChange={(v) => t.setFilter('queueIds', v)} placeholder="All queues" options={(lookups.data?.queues ?? []).map((q) => ({ value: q.id, label: q.name }))} />
            <FilterSelect value={t.filters.priorityIds} onChange={(v) => t.setFilter('priorityIds', v)} placeholder="Any priority" options={(lookups.data?.priorities ?? []).map((p) => ({ value: p.id, label: p.name }))} />
            <FilterSelect
              value={t.filters.assignedUserId}
              onChange={(v) => t.setFilter('assignedUserId', v)}
              placeholder="Any assignee"
              options={[{ value: 'me', label: 'Assigned to me' }, { value: 'none', label: 'Unassigned' }, ...(lookups.data?.users ?? []).filter((u) => u.isActive && u.isTechnician).map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }))]}
            />
          </div>
          <DataTable
            className="min-h-0 flex-1"
            columns={columns}
            data={list.data?.data}
            total={list.data?.total}
            page={t.page}
            pageSize={t.pageSize}
            loading={list.isLoading}
            sort={t.sortState}
            onSortChange={t.setSort}
            onPageChange={t.setPage}
            onRowClick={(r, e) => openTicket(r.id, e)}
            empty={
              <EmptyState
                icon={<ShieldCheck />}
                title={tab.key === 'breached' ? 'No breached tickets' : tab.key === 'at_risk' ? 'Nothing at risk' : 'No tickets'}
                description={tab.key === 'breached' || tab.key === 'at_risk' ? 'All open tickets are within their SLA targets.' : 'No tickets match the current filters.'}
              />
            }
          />
        </div>
        {can('reports.read') && (
          <aside className="hidden w-80 shrink-0 space-y-3 overflow-y-auto border-l border-border bg-background p-3 scrollbar-thin xl:block">
            <Card>
              <CardHeader title="Resolution compliance by priority" description="Tickets created in the last 30 days" />
              <div className="p-4">
                {byPriority.isLoading ? (
                  <Skeleton className="h-24" />
                ) : (
                  <BarList
                    max={100}
                    format={(n) => `${n}%`}
                    data={(byPriority.data?.data ?? []).map((r) => ({
                      label: r.group,
                      value: r.resolutionCompliance,
                      color: complianceTone(r.resolutionCompliance),
                      hint: `${r.resolutionMet}/${r.resolvedWithTarget} resolved within target · ${r.tickets} tickets`,
                    }))}
                    emptyLabel="No tickets in the period"
                  />
                )}
              </div>
            </Card>
            <Card>
              <CardHeader title="First response by priority" />
              <ul className="space-y-2.5 p-4">
                {(byPriority.data?.data ?? []).length === 0 && <li className="text-center text-xs text-muted">No data</li>}
                {(byPriority.data?.data ?? []).map((r) => {
                  const pct = r.withFirstResponseTarget ? Math.round((100 * r.firstResponseMet) / r.withFirstResponseTarget) : 100;
                  return (
                    <li key={r.group}>
                      <div className="mb-1 flex justify-between text-[12px]">
                        <span>{r.group}</span>
                        <span className="tabular-nums text-muted">
                          {r.firstResponseMet}/{r.withFirstResponseTarget} · <span className="font-medium text-foreground">{pct}%</span>
                        </span>
                      </div>
                      <Progress value={pct} tone={pct >= 95 ? 'success' : pct >= 85 ? 'warning' : 'danger'} />
                    </li>
                  );
                })}
              </ul>
            </Card>
            <Card>
              <CardHeader title="Resolution compliance by queue" />
              <div className="p-4">
                <BarList
                  max={100}
                  format={(n) => `${n}%`}
                  data={(byQueue.data?.data ?? []).map((r) => ({ label: r.group, value: r.resolutionCompliance, color: complianceTone(r.resolutionCompliance), hint: `${r.tickets} tickets` }))}
                  emptyLabel="No tickets in the period"
                />
              </div>
            </Card>
          </aside>
        )}
      </div>
    </div>
  );
}

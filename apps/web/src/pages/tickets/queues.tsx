import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueries, useQuery, keepPreviousData } from '@tanstack/react-query';
import { AlertTriangle, Flame, Inbox, Layers, Plus, UserX } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLookups } from '@/lib/lookups';
import { cn } from '@/lib/utils';
import { useTableState } from '@/hooks/use-table-state';
import { PageHeader, SearchInput, FilterSelect } from '@/components/page';
import { DataTable, type Column } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { EmptyState, Skeleton } from '@/components/ui/misc';
import { AssignToMeButton, ticketCols, type TicketRow } from '@/components/workspace/tickets';
import { useOpenTicket } from '@/lib/open-ticket';

interface QueueStats {
  open: number;
  unassigned: number;
  breached: number;
  critical: number;
}

const count = (q: Record<string, string | number>) => api.get<Paginated<unknown>>('/tickets', { ...q, statusCategory: 'open', pageSize: 1 }).then((r) => r.total);

const VIEWS = [
  { key: '', label: 'All open' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'breached', label: 'SLA breached' },
  { key: 'critical', label: 'Critical' },
];

export default function QueuesPage() {
  const navigate = useNavigate();
  const openTicket = useOpenTicket();
  const { can } = useAuth();
  const lookups = useLookups();
  const t = useTableState({ sort: 'dueAt', order: 'asc', pageSize: 50 });
  const queues = useMemo(() => (lookups.data?.queues ?? []).filter((q) => q.isActive !== false), [lookups.data]);
  const criticalIds = useMemo(() => (lookups.data?.priorities ?? []).filter((p) => p.level === 1).map((p) => p.id), [lookups.data]);
  const selected = Number(t.filters.queue) || queues[0]?.id;

  // Default to the first queue once lookups have loaded.
  useEffect(() => {
    if (!t.filters.queue && queues[0]) t.setFilters({ queue: queues[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queues.length]);

  const stats = useQueries({
    queries: queues.map((q) => ({
      queryKey: ['tickets', 'queue-stats', q.id, criticalIds],
      queryFn: async (): Promise<QueueStats> => {
        const [open, unassigned, breached, critical] = await Promise.all([
          count({ queueIds: q.id }),
          count({ queueIds: q.id, assignedUserId: 'none' }),
          count({ queueIds: q.id, slaState: 'breached' }),
          criticalIds.length ? count({ queueIds: q.id, priorityIds: criticalIds.join(',') }) : Promise.resolve(0),
        ]);
        return { open, unassigned, breached, critical };
      },
      refetchInterval: 60_000,
    })),
  });

  const view = t.filters.view ?? '';
  const { queue: _q, view: _v, ...restFilters } = t.filters;
  void _q;
  void _v;
  const query = {
    page: t.page,
    pageSize: t.pageSize,
    sort: t.sort,
    order: t.order,
    q: t.q || undefined,
    ...restFilters,
    queueIds: selected,
    statusCategory: 'open',
    assignedUserId: view === 'unassigned' ? 'none' : restFilters.assignedUserId,
    slaState: view === 'breached' ? 'breached' : undefined,
    priorityIds: view === 'critical' ? criticalIds.join(',') : restFilters.priorityIds,
  };
  const list = useQuery({
    queryKey: ['tickets', 'queue', query],
    queryFn: () => api.get<Paginated<TicketRow>>('/tickets', query),
    enabled: !!selected,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const columns: Column<TicketRow>[] = [
    ticketCols.ticket,
    ticketCols.company,
    ticketCols.priority,
    ticketCols.status,
    ticketCols.assignee,
    ticketCols.sla,
    ticketCols.age,
    ...(can('tickets.write')
      ? [{ id: 'actions', header: '', meta: { align: 'right' as const, className: 'w-20' }, cell: ({ row }: { row: { original: TicketRow } }) => <AssignToMeButton ticket={row.original} /> } as Column<TicketRow>]
      : []),
  ];

  const current = queues.find((q) => q.id === selected);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Queues"
        subtitle="Open work per service desk queue — pick a queue to triage its tickets"
        icon={<Layers />}
        actions={
          can('tickets.write') && (
            <Button variant="primary" onClick={() => navigate('/tickets/new')}>
              <Plus /> New ticket
            </Button>
          )
        }
      />
      <div className="border-b border-border bg-surface px-5 py-3">
        {lookups.isLoading ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px]" />
            ))}
          </div>
        ) : queues.length === 0 ? (
          <p className="text-sm text-muted">No queues are configured. An administrator can add them under Ticket settings.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6">
            {queues.map((q, i) => {
              const s = stats[i]?.data;
              const active = q.id === selected;
              return (
                <button
                  key={q.id}
                  onClick={() => t.setFilters({ queue: q.id, view: null })}
                  className={cn(
                    'cursor-pointer rounded-lg border bg-surface px-3.5 py-2.5 text-left shadow-card transition-colors',
                    active ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-border-strong',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn('truncate text-[13px] font-semibold', active && 'text-primary')}>{q.name}</span>
                    <span className="text-xl font-semibold tabular-nums">{s ? s.open : '·'}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1 text-[11px]">
                    <span className={cn('inline-flex items-center gap-1', s?.unassigned ? 'text-warning' : 'text-muted')} title="Unassigned">
                      <UserX className="size-3" /> {s?.unassigned ?? '–'}
                    </span>
                    <span className={cn('inline-flex items-center gap-1', s?.breached ? 'text-danger' : 'text-muted')} title="SLA breached">
                      <AlertTriangle className="size-3" /> {s?.breached ?? '–'}
                    </span>
                    <span className={cn('inline-flex items-center gap-1', s?.critical ? 'text-danger' : 'text-muted')} title="Critical priority">
                      <Flame className="size-3" /> {s?.critical ?? '–'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2">
        <div className="inline-flex rounded-md border border-border-strong p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => t.setFilter('view', v.key)}
              className={cn('cursor-pointer rounded px-2.5 py-1 text-xs font-medium', view === v.key ? 'bg-primary-soft text-primary' : 'text-muted hover:text-foreground')}
            >
              {v.label}
            </button>
          ))}
        </div>
        <SearchInput value={t.q} onChange={t.setQ} placeholder={`Search in ${current?.name ?? 'queue'}…`} />
        <FilterSelect
          value={t.filters.priorityIds}
          onChange={(v) => t.setFilter('priorityIds', v)}
          placeholder="Any priority"
          options={(lookups.data?.priorities ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
        {view !== 'unassigned' && (
          <FilterSelect
            value={t.filters.assignedUserId}
            onChange={(v) => t.setFilter('assignedUserId', v)}
            placeholder="Any assignee"
            options={[{ value: 'me', label: 'Assigned to me' }, { value: 'none', label: 'Unassigned' }, ...(lookups.data?.users ?? []).filter((u) => u.isActive && u.isTechnician).map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }))]}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 bg-surface">
        <DataTable
          className="h-full"
          columns={columns}
          data={selected ? list.data?.data : []}
          total={list.data?.total}
          page={t.page}
          pageSize={t.pageSize}
          loading={list.isLoading}
          sort={t.sortState}
          onSortChange={t.setSort}
          onPageChange={t.setPage}
          onRowClick={(r, e) => openTicket(r.id, e)}
          rowClassName={(r) => (r.sla.overall === 'breached' ? 'shadow-[inset_3px_0_0_var(--danger)]' : undefined)}
          empty={<EmptyState icon={<Inbox />} title="Queue is clear" description="No open tickets match this view." />}
        />
      </div>
    </div>
  );
}

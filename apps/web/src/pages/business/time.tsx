import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { addDays, format, isSameDay, parseISO, startOfWeek } from 'date-fns';
import type { RowSelectionState } from '@tanstack/react-table';
import { Check, ChevronLeft, ChevronRight, Clock, Download, Pencil, Plus, Trash2, X } from 'lucide-react';
import { TIME_ENTRY_STATUS, formatMinutes } from '@taskora/shared';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLookups } from '@/lib/lookups';
import { cn, fmtDate, fmtTime } from '@/lib/utils';
import { useTableState } from '@/hooks/use-table-state';
import { DataTable, type Column } from '@/components/data-table';
import { FilterSelect, ListLayout, PageHeader, SearchInput } from '@/components/page';
import { EntityPicker } from '@/components/entity-picker';
import { handleFormError } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState } from '@/components/ui/misc';
import { ConfirmDialog, Tooltip } from '@/components/ui/overlays';
import { TimeStatusBadge, enumOpts, useMoney } from '@/components/business/common';
import type { TimeEntryRow, TimeList } from '@/components/business/related-lists';
import { TimeEntryDialog } from '@/components/business/time-entry-form';

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
const mondayOf = (d: Date) => startOfWeek(d, { weekStartsOn: 1 });

export default function TimePage() {
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const lookups = useLookups();
  const money = useMoney();
  const thisMonday = ymd(mondayOf(new Date()));
  const t = useTableState({ filters: { userId: 'me', from: thisMonday, to: ymd(addDays(parseISO(thisMonday), 6)) } });
  const [editing, setEditing] = useState<TimeEntryRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TimeEntryRow | null>(null);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const canApprove = can('time.approve');
  const viewAll = can('time.read_all');

  /** API query: inclusive local dates → [from 00:00, to+1 00:00) instants. */
  const apiQuery = useMemo(() => {
    const { from, to, userId, ...rest } = t.query as Record<string, string | number | undefined>;
    return {
      ...rest,
      userId: !viewAll || userId === 'me' ? 'me' : userId === 'all' ? undefined : userId,
      from: from ? parseISO(String(from)).toISOString() : undefined,
      to: to ? addDays(parseISO(String(to)), 1).toISOString() : undefined,
    };
  }, [t.query, viewAll]);

  const list = useQuery({
    queryKey: ['time-entries', apiQuery],
    queryFn: () => api.get<TimeList>('/time-entries', apiQuery),
    placeholderData: keepPreviousData,
  });

  // Week strip follows the "from" date of the filter.
  const weekStart = mondayOf(t.filters.from ? parseISO(t.filters.from) : new Date());
  const weekUser = viewAll && t.filters.userId && !['me', 'all'].includes(t.filters.userId) ? t.filters.userId : undefined;
  const week = useQuery({
    queryKey: ['time-week', ymd(weekStart), weekUser],
    queryFn: () => api.get<{ data: { day: string; minutes: number; billable: number }[] }>('/time-entries/week', { start: weekStart.toISOString(), userId: weekUser }),
  });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const dayTotals = (d: Date) => week.data?.data.find((r) => r.day === ymd(d));
  const weekTotal = (week.data?.data ?? []).reduce((a, r) => a + r.minutes, 0);
  const weekBillable = (week.data?.data ?? []).reduce((a, r) => a + r.billable, 0);
  const setWeek = (monday: Date) => t.setFilters({ from: ymd(monday), to: ymd(addDays(monday, 6)) });
  const weekUserName = weekUser ? lookups.data?.users.find((u) => u.id === Number(weekUser)) : null;

  const approve = useMutation({
    mutationFn: (status: 'approved' | 'rejected') => api.post<{ updated: number }>('/time-entries/approve', { ids: Object.keys(selection).map(Number), status }),
    onSuccess: (r, status) => {
      toast.success(`${r.updated} entr${r.updated === 1 ? 'y' : 'ies'} ${status}`);
      setSelection({});
      qc.invalidateQueries({ queryKey: ['time-entries'] });
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: (e: TimeEntryRow) => api.delete(`/time-entries/${e.id}`),
    onSuccess: () => {
      toast.success('Time entry deleted');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['time-entries'] });
      qc.invalidateQueries({ queryKey: ['time-week'] });
    },
    onError: (e) => {
      setDeleting(null);
      handleFormError(e);
    },
  });

  const canEdit = (e: TimeEntryRow) => e.status !== 'billed' && can('time.write') && (e.userId === me?.user.id || can('time.write_all'));

  const columns: Column<TimeEntryRow>[] = [
    {
      header: 'Date',
      meta: { className: 'whitespace-nowrap' },
      cell: ({ row }) => (
        <div>
          <div>{fmtDate(row.original.startedAt)}</div>
          <div className="text-[11px] text-muted">{fmtTime(row.original.startedAt)}</div>
        </div>
      ),
    },
    ...(viewAll ? [{ header: 'Resource', cell: ({ row }) => row.original.userName } as Column<TimeEntryRow>] : []),
    {
      header: 'Work item',
      meta: { className: 'max-w-72' },
      cell: ({ row: { original: e } }) => (
        <div className="min-w-0">
          {e.ticketId ? (
            <Link to={`/tickets/${e.ticketId}`} className="block truncate hover:text-primary" onClick={(ev) => ev.stopPropagation()}>
              <span className="text-muted">{e.ticketNumber}</span> {e.ticketTitle}
            </Link>
          ) : (
            <Link to={`/projects/${e.projectId}`} className="block truncate hover:text-primary" onClick={(ev) => ev.stopPropagation()}>
              {e.taskTitle} <span className="text-muted">· {e.projectName}</span>
            </Link>
          )}
          <Link to={`/companies/${e.companyId}`} className="block truncate text-[11px] text-muted hover:text-primary" onClick={(ev) => ev.stopPropagation()}>
            {e.companyName}
          </Link>
        </div>
      ),
    },
    { header: 'Work type', cell: ({ row }) => row.original.workTypeName ?? <span className="text-subtle">—</span> },
    {
      header: 'Description',
      meta: { className: 'max-w-80' },
      cell: ({ row }) => (
        <Tooltip content={<span className="whitespace-pre-wrap">{row.original.description}</span>}>
          <span className="line-clamp-2 text-muted">{row.original.description}</span>
        </Tooltip>
      ),
    },
    { header: 'Duration', meta: { align: 'right' }, cell: ({ row }) => <span className="font-medium">{formatMinutes(row.original.durationMinutes)}</span> },
    {
      header: 'Billing',
      cell: ({ row: { original: e } }) => (
        <div className="flex flex-col items-start gap-0.5">
          {e.contractCovered ? <Badge tone="info">Covered</Badge> : e.billable ? <Badge tone="success">Billable</Badge> : <Badge>Non-billable</Badge>}
          {e.contractId && (
            <Link to={`/contracts/${e.contractId}`} className="max-w-36 truncate text-[11px] text-muted hover:text-primary" onClick={(ev) => ev.stopPropagation()}>
              {e.contractName}
            </Link>
          )}
          {e.billable && !e.contractCovered && e.hourlyRate != null && <span className="text-[11px] text-muted">{money(e.hourlyRate)}/h</span>}
        </div>
      ),
    },
    { header: 'Status', cell: ({ row }) => <TimeStatusBadge status={row.original.status} /> },
    {
      id: 'actions',
      header: '',
      meta: { className: 'w-16' },
      cell: ({ row: { original: e } }) =>
        canEdit(e) && (
          <div className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100">
            <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={(ev) => (ev.stopPropagation(), setEditing(e))}>
              <Pencil />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={(ev) => (ev.stopPropagation(), setDeleting(e))}>
              <Trash2 />
            </Button>
          </div>
        ),
    },
  ];

  const totals = list.data?.totals;
  const selected = Object.keys(selection).length;
  const userOptions = [
    { value: 'all', label: 'All resources' },
    ...(lookups.data?.users ?? []).filter((u) => u.isActive).map((u) => ({ value: String(u.id), label: `${u.firstName} ${u.lastName}` })),
  ];

  return (
    <ListLayout
      header={
        <PageHeader
          title="Timesheet"
          subtitle="Logged time, approvals and billing classification"
          icon={<Clock />}
          actions={
            <>
              <Button onClick={() => downloadUrl('/time-entries/export.csv', apiQuery as never)}>
                <Download /> Export CSV
              </Button>
              {can('time.write') && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus /> Log time
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-wrap items-stretch gap-2 pb-3">
            <div className="flex items-center gap-1">
              <Button size="icon-sm" variant="ghost" aria-label="Previous week" onClick={() => setWeek(addDays(weekStart, -7))}>
                <ChevronLeft />
              </Button>
              <div className="w-36 text-center text-xs">
                <div className="font-medium">
                  {format(weekStart, 'dd MMM')} – {format(addDays(weekStart, 6), 'dd MMM yyyy')}
                </div>
                <div className="text-muted">{weekUserName ? `${weekUserName.firstName} ${weekUserName.lastName}` : 'My week'}</div>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label="Next week" onClick={() => setWeek(addDays(weekStart, 7))}>
                <ChevronRight />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setWeek(mondayOf(new Date()))}>
                This week
              </Button>
            </div>
            <div className="grid min-w-full flex-1 grid-cols-8 gap-1 sm:min-w-0">
              {days.map((d) => {
                const tot = dayTotals(d);
                const active = t.filters.from === ymd(d) && t.filters.to === ymd(d);
                const today = isSameDay(d, new Date());
                return (
                  <button
                    key={ymd(d)}
                    type="button"
                    onClick={() => (active ? setWeek(weekStart) : t.setFilters({ from: ymd(d), to: ymd(d) }))}
                    className={cn(
                      'cursor-pointer rounded-md border px-1 py-1 text-left transition-colors hover:border-border-strong sm:px-2',
                      active ? 'border-primary bg-primary-soft' : 'border-border bg-surface-2/50',
                    )}
                    title={active ? 'Show whole week' : 'Show this day only'}
                  >
                    <div className={cn('text-[11px] font-medium uppercase', today ? 'text-primary' : 'text-muted')}>{format(d, 'EEE dd')}</div>
                    <div className={cn('text-sm font-semibold tabular-nums', !tot && 'text-subtle')}>{formatMinutes(tot?.minutes ?? 0)}</div>
                    <div className="text-[10px] text-muted tabular-nums">{tot ? `${formatMinutes(tot.billable)} bill.` : ' '}</div>
                  </button>
                );
              })}
              <div className="rounded-md border border-border px-1 py-1 sm:px-2">
                <div className="text-[11px] font-medium uppercase text-muted">Week</div>
                <div className="text-sm font-semibold tabular-nums">{formatMinutes(weekTotal)}</div>
                <div className="text-[10px] text-muted tabular-nums">{formatMinutes(weekBillable)} bill.</div>
              </div>
            </div>
          </div>
        </PageHeader>
      }
      toolbar={
        <>
          <SearchInput value={t.q} onChange={t.setQ} placeholder="Search description, ticket, company…" className="w-56" />
          {viewAll && <FilterSelect value={t.filters.userId === 'me' ? String(me?.user.id) : t.filters.userId} onChange={(v) => t.setFilter('userId', v || 'all')} placeholder="All resources" options={userOptions.slice(1)} />}
          <div className="flex items-center gap-1 text-xs text-muted">
            <input type="date" value={t.filters.from ?? ''} onChange={(e) => t.setFilter('from', e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[13px] text-foreground" aria-label="From" />
            –
            <input type="date" value={t.filters.to ?? ''} onChange={(e) => t.setFilter('to', e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[13px] text-foreground" aria-label="To" />
          </div>
          <FilterSelect value={t.filters.billable} onChange={(v) => t.setFilter('billable', v)} placeholder="Billable & not" options={[{ value: 'true', label: 'Billable' }, { value: 'false', label: 'Non-billable' }]} />
          <FilterSelect value={t.filters.status} onChange={(v) => t.setFilter('status', v)} placeholder="Any status" options={enumOpts(TIME_ENTRY_STATUS)} />
          <div className="w-52">
            <EntityPicker kind="company" value={t.filters.companyId ? Number(t.filters.companyId) : null} onChange={(id) => t.setFilter('companyId', id)} placeholder="All companies" />
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted">
            {totals && (
              <>
                <span>
                  Total <b className="text-foreground tabular-nums">{formatMinutes(totals.minutes)}</b>
                </span>
                <span>
                  Billable <b className="text-foreground tabular-nums">{formatMinutes(totals.billableMinutes)}</b>
                </span>
                <span>
                  Covered <b className="text-foreground tabular-nums">{formatMinutes(totals.coveredMinutes)}</b>
                </span>
                <span>
                  Non-billable <b className="text-foreground tabular-nums">{formatMinutes(totals.minutes - totals.billableMinutes)}</b>
                </span>
              </>
            )}
          </div>
          {canApprove && selected > 0 && (
            <div className="flex w-full items-center gap-2 rounded-md bg-primary-soft px-3 py-1.5 text-[13px]">
              <span className="font-medium">{selected} selected</span>
              <Button size="sm" variant="primary" loading={approve.isPending && approve.variables === 'approved'} onClick={() => approve.mutate('approved')}>
                <Check /> Approve
              </Button>
              <Button size="sm" variant="danger" loading={approve.isPending && approve.variables === 'rejected'} onClick={() => approve.mutate('rejected')}>
                <X /> Reject
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelection({})}>
                Clear
              </Button>
            </div>
          )}
        </>
      }
    >
      <DataTable
        className="h-full"
        columns={columns}
        data={list.data?.data}
        total={list.data?.total}
        page={t.page}
        pageSize={t.pageSize}
        loading={list.isLoading}
        onPageChange={t.setPage}
        selectable={canApprove}
        selection={selection}
        onSelectionChange={setSelection}
        getRowId={(r) => String(r.id)}
        onRowClick={(e) => canEdit(e) && setEditing(e)}
        empty={
          <EmptyState
            icon={<Clock />}
            title="No time entries"
            description="Nothing logged for these filters. Log time against a ticket or a project task."
            action={
              can('time.write') && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus /> Log time
                </Button>
              )
            }
          />
        }
      />
      <TimeEntryDialog open={creating} onOpenChange={setCreating} />
      <TimeEntryDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} entry={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete time entry?"
        description={deleting ? `${formatMinutes(deleting.durationMinutes)} on ${fmtDate(deleting.startedAt)}: “${deleting.description.slice(0, 120)}”` : undefined}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </ListLayout>
  );
}

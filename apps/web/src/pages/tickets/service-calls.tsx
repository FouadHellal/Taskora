import { useMemo, useState } from 'react';
import { TicketLink } from '@/lib/open-ticket';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { addDays, differenceInMinutes, format } from 'date-fns';
import { CalendarClock, CalendarDays, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { SERVICE_CALL_STATUS, formatMinutes } from '@taskora/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLookups } from '@/lib/lookups';
import { cn, fmtTime } from '@/lib/utils';
import { FilterSelect, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Avatar, EmptyState, Skeleton } from '@/components/ui/misc';
import { ConfirmDialog, DropdownContent, DropdownItem, DropdownMenu, DropdownTrigger } from '@/components/ui/overlays';
import { EntityPicker } from '@/components/entity-picker';
import { handleFormError } from '@/components/form';
import { ServiceCallDialog, ServiceCallStatusBadge, type ServiceCall } from '@/components/workspace/service-call-dialog';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

export default function ServiceCallsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const lookups = useLookups();
  const canWrite = can('tickets.write');
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? iso(addDays(new Date(), -7));
  const to = params.get('to') ?? iso(addDays(new Date(), 30));
  const userId = params.get('userId') ?? '';
  const companyId = params.get('companyId') ? Number(params.get('companyId')) : null;
  const status = params.get('status') ?? '';
  const [dialog, setDialog] = useState<{ call?: ServiceCall | null } | null>(null);
  const [deleting, setDeleting] = useState<ServiceCall | null>(null);

  const set = (patch: Record<string, string | number | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, String(v)));
        return next;
      },
      { replace: true },
    );

  // Dates are local days; the API expects instants.
  const fromInstant = new Date(`${from}T00:00:00`).toISOString();
  const toInstant = new Date(`${to}T23:59:59`).toISOString();
  const list = useQuery({
    queryKey: ['service-calls', fromInstant, toInstant, userId, companyId],
    queryFn: () => api.get<{ data: ServiceCall[] }>('/service-calls', { from: fromInstant, to: toInstant, userId: userId || undefined, companyId }),
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/service-calls/${id}`),
    onSuccess: () => {
      toast.success('Service call deleted');
      qc.invalidateQueries({ queryKey: ['service-calls'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      setDeleting(null);
    },
    onError: (e) => handleFormError(e),
  });

  const rows = useMemo(() => (list.data?.data ?? []).filter((c) => !status || c.status === status), [list.data, status]);
  const groups = useMemo(() => {
    const out: { day: string; date: Date; items: ServiceCall[] }[] = [];
    for (const c of rows) {
      const d = new Date(c.startAt);
      const key = iso(d);
      const last = out[out.length - 1];
      if (last?.day === key) last.items.push(c);
      else out.push({ day: key, date: d, items: [c] });
    }
    return out;
  }, [rows]);
  const totalMinutes = rows.filter((c) => c.status !== 'cancelled').reduce((a, c) => a + differenceInMinutes(new Date(c.endAt), new Date(c.startAt)), 0);
  const todayKey = iso(new Date());

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Service calls"
        subtitle="Scheduled on-site and remote appointments"
        icon={<CalendarClock />}
        actions={
          <>
            <Button onClick={() => navigate('/calendar')}>
              <CalendarDays /> Calendar
            </Button>
            {canWrite && (
              <Button variant="primary" onClick={() => setDialog({})}>
                <Plus /> New service call
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2">
        <div className="flex items-center gap-1.5">
          <input type="date" aria-label="From" value={from} max={to} onChange={(e) => e.target.value && set({ from: e.target.value })} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[13px] focus:border-primary focus:outline-none dark:[color-scheme:dark]" />
          <span className="text-xs text-muted">to</span>
          <input type="date" aria-label="To" value={to} min={from} onChange={(e) => e.target.value && set({ to: e.target.value })} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[13px] focus:border-primary focus:outline-none dark:[color-scheme:dark]" />
        </div>
        <FilterSelect
          value={userId}
          onChange={(v) => set({ userId: v })}
          placeholder="All technicians"
          options={[{ value: 'me', label: 'Me' }, ...(lookups.data?.users ?? []).filter((u) => u.isActive && u.isTechnician).map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }))]}
        />
        <div className="w-56">
          <EntityPicker kind="company" value={companyId} onChange={(id) => set({ companyId: id })} placeholder="All companies" />
        </div>
        <FilterSelect value={status} onChange={(v) => set({ status: v })} placeholder="Any status" options={SERVICE_CALL_STATUS.values.map((v) => ({ value: v, label: SERVICE_CALL_STATUS.labels[v] }))} />
        <span className="ml-auto text-xs text-muted">
          {rows.length} call{rows.length === 1 ? '' : 's'} · {formatMinutes(totalMinutes)} scheduled
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-surface scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-20">
            <tr>
              {['Time', 'Service call', 'Company', 'Technicians', 'Tickets', 'Status', ''].map((h, i) => (
                <th key={i} className="whitespace-nowrap border-b border-border bg-surface-2 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.isLoading &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={7} className="border-b border-border px-3 py-2">
                    <Skeleton className="h-4" />
                  </td>
                </tr>
              ))}
            {groups.map((g) => (
              <DayGroup
                key={g.day}
                label={g.day === todayKey ? `Today · ${format(g.date, 'EEEE d MMMM')}` : format(g.date, 'EEEE d MMMM yyyy')}
                today={g.day === todayKey}
                past={g.day < todayKey}
                items={g.items}
                canWrite={canWrite}
                onOpen={(c) => setDialog({ call: c })}
                onDelete={setDeleting}
              />
            ))}
          </tbody>
        </table>
        {!list.isLoading && rows.length === 0 && (
          <EmptyState
            icon={<CalendarClock />}
            title="No service calls in this period"
            description="Adjust the date range or filters, or schedule a new call."
            action={
              canWrite && (
                <Button variant="primary" onClick={() => setDialog({})}>
                  <Plus /> New service call
                </Button>
              )
            }
          />
        )}
      </div>
      <ServiceCallDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} call={dialog?.call} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete service call?"
        description={`"${deleting?.title}" will be removed from all technicians' calendars.`}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function DayGroup({
  label,
  today,
  past,
  items,
  canWrite,
  onOpen,
  onDelete,
}: {
  label: string;
  today: boolean;
  past: boolean;
  items: ServiceCall[];
  canWrite: boolean;
  onOpen: (c: ServiceCall) => void;
  onDelete: (c: ServiceCall) => void;
}) {
  return (
    <>
      <tr>
        <td colSpan={7} className={cn('sticky top-[29px] z-10 border-b border-border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide', today ? 'bg-primary-soft text-primary' : 'bg-surface-2/80 text-muted backdrop-blur')}>
          {label}
          <span className="ml-2 font-normal normal-case">{items.length} call{items.length === 1 ? '' : 's'}</span>
        </td>
      </tr>
      {items.map((c) => (
        <tr key={c.id} onClick={() => onOpen(c)} className={cn('group cursor-pointer bg-surface hover:bg-surface-2', past && 'text-muted')}>
          <td className="whitespace-nowrap border-b border-border px-3 py-1.5 tabular-nums">
            {fmtTime(c.startAt)}–{fmtTime(c.endAt)}
            <span className="ml-1.5 text-[11px] text-subtle">{formatMinutes(differenceInMinutes(new Date(c.endAt), new Date(c.startAt)))}</span>
          </td>
          <td className="max-w-[22rem] border-b border-border px-3 py-1.5">
            <div className={cn('truncate font-medium text-foreground', c.status === 'cancelled' && 'line-through opacity-70')}>{c.title}</div>
            {c.description && <div className="truncate text-xs text-muted">{c.description}</div>}
          </td>
          <td className="border-b border-border px-3 py-1.5">
            <Link to={`/companies/${c.companyId}`} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
              {c.companyName}
            </Link>
          </td>
          <td className="border-b border-border px-3 py-1.5">
            {c.users.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {c.users.map((u) => (
                  <span key={u.id} className="inline-flex items-center gap-1 whitespace-nowrap text-xs">
                    <Avatar name={u.name} className="size-5 text-[9px]" />
                    {u.name}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-xs text-warning">Unassigned</span>
            )}
          </td>
          <td className="border-b border-border px-3 py-1.5">
            {c.tickets.length ? (
              <div className="flex flex-col gap-0.5">
                {c.tickets.map((t) => (
                  <TicketLink key={t.id} ticketId={t.id} onClick={(e) => e.stopPropagation()} className="max-w-[16rem] truncate text-xs hover:text-primary" title={t.title}>
                    <span className="font-mono text-muted">{t.ticketNumber}</span> {t.title}
                  </TicketLink>
                ))}
              </div>
            ) : (
              <span className="text-xs text-subtle">—</span>
            )}
          </td>
          <td className="border-b border-border px-3 py-1.5">
            <ServiceCallStatusBadge status={c.status} />
          </td>
          <td className="w-10 border-b border-border px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
            {canWrite && (
              <DropdownMenu>
                <DropdownTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label="Actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownTrigger>
                <DropdownContent>
                  <DropdownItem onSelect={() => onOpen(c)}>
                    <Pencil /> Edit
                  </DropdownItem>
                  <DropdownItem danger onSelect={() => onDelete(c)}>
                    <Trash2 /> Delete
                  </DropdownItem>
                </DropdownContent>
              </DropdownMenu>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

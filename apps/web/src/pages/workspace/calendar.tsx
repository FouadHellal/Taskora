import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInMinutes,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight, FolderKanban, Plus, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLookups } from '@/lib/lookups';
import { cn, fmtTime } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Dot, Spinner } from '@/components/ui/misc';
import { Tooltip } from '@/components/ui/overlays';
import { ServiceCallDialog, type ServiceCall, type ServiceCallDefaults } from '@/components/workspace/service-call-dialog';
import { useOpenLink } from '@/lib/open-ticket';

interface CalendarFeed {
  serviceCalls: ServiceCall[];
  ticketDue: { id: number; ticketNumber: string; title: string; at: string; priorityColor: string }[];
  taskDue: { id: number; projectId: number; title: string; dueDate: string; projectName: string }[];
}

type View = 'week' | 'month';
const HOUR_PX = 44;
const WEEK_OPTS = { weekStartsOn: 1 as const };

const CALL_STYLE: Record<string, string> = {
  scheduled: 'border-primary bg-primary-soft text-foreground',
  in_progress: 'border-warning bg-warning-soft text-foreground',
  completed: 'border-success bg-success-soft text-foreground',
  cancelled: 'border-border-strong bg-surface-2 text-muted line-through',
};

interface Segment {
  call: ServiceCall;
  start: Date;
  end: Date;
  lane: number;
  lanes: number;
}

/** Splits calls into per-day segments and assigns side-by-side lanes for overlaps. */
function layoutDay(calls: ServiceCall[], day: Date): Segment[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  const segs = calls
    .map((call) => {
      const s = new Date(call.startAt);
      const e = new Date(call.endAt);
      if (e <= dayStart || s >= dayEnd) return null;
      return { call, start: s < dayStart ? dayStart : s, end: e > dayEnd ? dayEnd : e, lane: 0, lanes: 1 };
    })
    .filter((x): x is Segment => !!x)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
  let cluster: Segment[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const n = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) c.lanes = n;
    cluster = [];
  };
  for (const seg of segs) {
    if (cluster.length && seg.start.getTime() >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.end > seg.start).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    seg.lane = lane;
    cluster.push(seg);
    clusterEnd = Math.max(clusterEnd, seg.end.getTime());
  }
  flush();
  return segs;
}

export default function CalendarPage() {
  const navigate = useNavigate();
  // Due-ticket chips open tickets the configured way (own window or here).
  const openLink = useOpenLink();
  const { can, me } = useAuth();
  const lookups = useLookups();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'month' ? 'month' : 'week';
  const anchor = params.get('date') ? parseISO(params.get('date')!) : new Date();
  const user = params.get('user') ?? '';
  const [dialog, setDialog] = useState<{ call?: ServiceCall | null; defaults?: ServiceCallDefaults } | null>(null);
  const canWrite = can('tickets.write');

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
        return next;
      },
      { replace: true },
    );
  const goTo = (d: Date, v: View = view) => set({ date: format(d, 'yyyy-MM-dd'), view: v === 'week' ? null : v });

  const { from, to, days } = useMemo(() => {
    if (view === 'week') {
      const s = startOfWeek(anchor, WEEK_OPTS);
      return { from: s, to: addDays(s, 7), days: Array.from({ length: 7 }, (_, i) => addDays(s, i)) };
    }
    const s = startOfWeek(startOfMonth(anchor), WEEK_OPTS);
    const e = addDays(endOfWeek(endOfMonth(anchor), WEEK_OPTS), 1);
    const n = Math.round(differenceInMinutes(e, s) / 1440);
    return { from: s, to: e, days: Array.from({ length: n }, (_, i) => addDays(s, i)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, format(anchor, 'yyyy-MM-dd')]);

  const feed = useQuery({
    queryKey: ['calendar', from.toISOString(), to.toISOString(), user],
    queryFn: () => api.get<CalendarFeed>('/calendar', { from: from.toISOString(), to: to.toISOString(), userId: user || undefined }),
    placeholderData: keepPreviousData,
  });

  const title =
    view === 'week'
      ? `${format(days[0]!, 'd MMM')} – ${format(days[6]!, 'd MMM yyyy')}`
      : format(anchor, 'MMMM yyyy');

  const techOptions = (lookups.data?.users ?? []).filter((u) => u.isActive && u.isTechnician && u.id !== me?.user.id);
  const openNew = (start?: Date) => canWrite && setDialog({ defaults: start ? { startAt: start, userIds: user && user !== 'all' ? [Number(user)] : undefined } : undefined });
  const data = feed.data;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Calendar"
        subtitle="Service calls, ticket deadlines and project task due dates"
        icon={<CalendarDays />}
        actions={
          canWrite && (
            <Button variant="primary" onClick={() => openNew()}>
              <Plus /> New service call
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2">
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Previous" onClick={() => goTo(view === 'week' ? addWeeks(anchor, -1) : addMonths(anchor, -1))}>
            <ChevronLeft />
          </Button>
          <Button size="sm" onClick={() => goTo(new Date())}>
            Today
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Next" onClick={() => goTo(view === 'week' ? addWeeks(anchor, 1) : addMonths(anchor, 1))}>
            <ChevronRight />
          </Button>
        </div>
        <h2 className="min-w-44 text-[15px] font-semibold">{title}</h2>
        {feed.isFetching && <Spinner />}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Users className="size-3.5 text-muted" />
            <select
              value={user}
              onChange={(e) => set({ user: e.target.value || null })}
              className="h-8 max-w-52 cursor-pointer rounded-md border border-border-strong bg-surface px-2 text-[13px] focus:border-primary focus:outline-none"
              aria-label="Technician"
            >
              <option value="">My calendar</option>
              <option value="all">All technicians</option>
              {techOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName}
                </option>
              ))}
            </select>
          </div>
          <div className="inline-flex rounded-md border border-border-strong p-0.5">
            {(['week', 'month'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => goTo(anchor, v)}
                className={cn('cursor-pointer rounded px-2.5 py-1 text-xs font-medium capitalize', view === v ? 'bg-primary-soft text-primary' : 'text-muted hover:text-foreground')}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 bg-surface">
        {view === 'week' ? (
          <WeekView days={days} data={data} canWrite={canWrite} onNew={openNew} onCall={(c) => setDialog({ call: c })} navigate={openLink} />
        ) : (
          <MonthView days={days} anchor={anchor} data={data} onDay={(d) => goTo(d, 'week')} onCall={(c) => setDialog({ call: c })} navigate={openLink} canWrite={canWrite} onNew={openNew} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-border bg-surface px-5 py-1.5 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-1 rounded-sm bg-primary" /> Service call
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Dot color="var(--danger)" /> Ticket due (priority colour)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <FolderKanban className="size-3" /> Project task due
        </span>
        {data && (
          <span className="ml-auto">
            {data.serviceCalls.length} service calls · {data.ticketDue.length} ticket deadlines · {data.taskDue.length} task deadlines
          </span>
        )}
      </div>

      <ServiceCallDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} call={dialog?.call} defaults={dialog?.defaults} />
    </div>
  );
}

function buildDueChips({ day, data, navigate, limit }: { day: Date; data?: CalendarFeed; navigate: (p: string) => void; limit?: number }) {
  const key = format(day, 'yyyy-MM-dd');
  const tickets = (data?.ticketDue ?? []).filter((t) => isSameDay(new Date(t.at), day));
  const tasks = (data?.taskDue ?? []).filter((t) => t.dueDate === key);
  const items = [
    ...tickets.map((t) => (
      <Tooltip key={`t${t.id}`} content={`${t.ticketNumber} ${t.title} — due ${fmtTime(t.at)}`}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/tickets/${t.id}`);
          }}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded px-1 py-px text-left text-[11px] hover:bg-surface-2"
        >
          <Dot color={t.priorityColor} className="size-1.5" />
          <span className="shrink-0 tabular-nums text-muted">{fmtTime(t.at)}</span>
          <span className="truncate">{t.ticketNumber}</span>
        </button>
      </Tooltip>
    )),
    ...tasks.map((t) => (
      <Tooltip key={`k${t.id}`} content={`${t.title} — ${t.projectName}`}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/projects/${t.projectId}`);
          }}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded px-1 py-px text-left text-[11px] hover:bg-surface-2"
        >
          <FolderKanban className="size-3 shrink-0 text-muted" />
          <span className="truncate">{t.title}</span>
        </button>
      </Tooltip>
    )),
  ];
  if (limit !== undefined && items.length > limit) return { shown: items.slice(0, limit), more: items.length - limit, total: items.length };
  return { shown: items, more: 0, total: items.length };
}

function WeekView({
  days,
  data,
  canWrite,
  onNew,
  onCall,
  navigate,
}: {
  days: Date[];
  data?: CalendarFeed;
  canWrite: boolean;
  onNew: (start?: Date) => void;
  onCall: (c: ServiceCall) => void;
  navigate: (p: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const calls = data?.serviceCalls ?? [];
  const perDay = days.map((d) => layoutDay(calls, d));
  // Visible hour range: business hours, widened to fit any event.
  let startH = 7;
  let endH = 19;
  for (const segs of perDay)
    for (const s of segs) {
      startH = Math.min(startH, s.start.getHours());
      endH = Math.max(endH, s.end.getHours() + (s.end.getMinutes() ? 1 : 0) || 24);
    }
  endH = Math.min(24, endH);
  const hours = Array.from({ length: endH - startH }, (_, i) => startH + i);

  useEffect(() => {
    // Scroll to ~8:00 on first render.
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (8 - startH) * HOUR_PX - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dueRows = days.map((d) => buildDueChips({ day: d, data, navigate }));
  const hasDue = dueRows.some((r) => r.total > 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-border pr-2">
        <div className="w-14 shrink-0" />
        {days.map((d) => {
          const today = isSameDay(d, now);
          return (
            <div key={d.toISOString()} className="min-w-0 flex-1 border-l border-border px-2 py-1.5">
              <div className={cn('text-[11px] font-medium uppercase tracking-wide', today ? 'text-primary' : 'text-muted')}>{format(d, 'EEE')}</div>
              <div className={cn('text-lg font-semibold leading-tight tabular-nums', today && 'text-primary')}>{format(d, 'd')}</div>
            </div>
          );
        })}
      </div>
      {hasDue && (
        <div className="flex border-b border-border bg-surface-2/40 pr-2">
          <div className="w-14 shrink-0 px-1.5 py-1 text-right text-[10px] font-medium uppercase text-subtle">Due</div>
          {dueRows.map((r, i) => (
            <div key={i} className="max-h-24 min-w-0 flex-1 space-y-px overflow-y-auto border-l border-border p-1 scrollbar-thin">
              {r.shown}
            </div>
          ))}
        </div>
      )}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="relative flex" style={{ height: hours.length * HOUR_PX }}>
          <div className="w-14 shrink-0">
            {hours.map((h) => (
              <div key={h} className="relative text-right text-[10px] tabular-nums text-subtle" style={{ height: HOUR_PX }}>
                <span className="absolute -top-1.5 right-1.5">{h === startH ? '' : `${String(h).padStart(2, '0')}:00`}</span>
              </div>
            ))}
          </div>
          {days.map((d, di) => {
            const today = isSameDay(d, now);
            const nowTop = ((now.getHours() - startH) * 60 + now.getMinutes()) * (HOUR_PX / 60);
            return (
              <div
                key={d.toISOString()}
                className={cn('relative min-w-0 flex-1 border-l border-border', today && 'bg-primary-soft/20', canWrite && 'cursor-copy')}
                onClick={(e) => {
                  if (!canWrite) return;
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const minutes = Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) * 30 + startH * 60;
                  const start = startOfDay(d);
                  start.setMinutes(minutes);
                  onNew(start);
                }}
              >
                {hours.map((h) => (
                  <div key={h} className="border-b border-border/70" style={{ height: HOUR_PX }}>
                    <div className="h-1/2 border-b border-dashed border-border/40" />
                  </div>
                ))}
                {today && nowTop >= 0 && nowTop <= hours.length * HOUR_PX && (
                  <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop }}>
                    <span className="-ml-1 size-2 rounded-full bg-danger" />
                    <span className="h-px flex-1 bg-danger" />
                  </div>
                )}
                {perDay[di]!.map((s) => {
                  const top = ((s.start.getHours() - startH) * 60 + s.start.getMinutes()) * (HOUR_PX / 60);
                  const height = Math.max(20, differenceInMinutes(s.end, s.start) * (HOUR_PX / 60) - 2);
                  const width = 100 / s.lanes;
                  return (
                    <button
                      key={s.call.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCall(s.call);
                      }}
                      className={cn(
                        'absolute z-10 cursor-pointer overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left shadow-sm transition-shadow hover:shadow-md',
                        CALL_STYLE[s.call.status] ?? CALL_STYLE.scheduled,
                      )}
                      style={{ top, height, left: `calc(${s.lane * width}% + 2px)`, width: `calc(${width}% - 4px)` }}
                      title={`${s.call.title}\n${s.call.companyName}\n${fmtTime(s.call.startAt)}–${fmtTime(s.call.endAt)}\n${s.call.users.map((u) => u.name).join(', ')}`}
                    >
                      <div className="truncate text-[11px] font-semibold leading-tight">{s.call.title}</div>
                      {height > 30 && (
                        <div className="truncate text-[10px] leading-tight text-muted">
                          {fmtTime(s.call.startAt)}–{fmtTime(s.call.endAt)} · {s.call.companyName}
                        </div>
                      )}
                      {height > 46 && s.call.users.length > 0 && <div className="truncate text-[10px] leading-tight text-muted">{s.call.users.map((u) => u.name).join(', ')}</div>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthView({
  days,
  anchor,
  data,
  onDay,
  onCall,
  navigate,
  canWrite,
  onNew,
}: {
  days: Date[];
  anchor: Date;
  data?: CalendarFeed;
  onDay: (d: Date) => void;
  onCall: (c: ServiceCall) => void;
  navigate: (p: string) => void;
  canWrite: boolean;
  onNew: (start?: Date) => void;
}) {
  const now = new Date();
  const weeks = days.length / 7;
  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-7 border-b border-border">
        {days.slice(0, 7).map((d) => (
          <div key={d.toISOString()} className="border-l border-border px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted first:border-l-0">
            {format(d, 'EEE')}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto scrollbar-thin" style={{ gridTemplateRows: `repeat(${weeks}, minmax(112px, 1fr))` }}>
        {days.map((d) => {
          const calls = (data?.serviceCalls ?? []).filter((c) => new Date(c.startAt) < addDays(startOfDay(d), 1) && new Date(c.endAt) > startOfDay(d));
          const due = buildDueChips({ day: d, data, navigate, limit: Math.max(0, 4 - calls.length) });
          const extraCalls = Math.max(0, calls.length - 4);
          const more = due.more + extraCalls;
          const today = isSameDay(d, now);
          return (
            <div
              key={d.toISOString()}
              className={cn(
                'group min-w-0 border-b border-l border-border p-1 [&:nth-child(7n+1)]:border-l-0',
                !isSameMonth(d, anchor) && 'bg-surface-2/50',
                canWrite && 'cursor-copy',
              )}
              onClick={() => {
                if (!canWrite) return;
                const s = startOfDay(d);
                s.setHours(9);
                onNew(s);
              }}
            >
              <div className="mb-0.5 flex items-center justify-between">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDay(d);
                  }}
                  className={cn(
                    'flex size-6 cursor-pointer items-center justify-center rounded-full text-xs font-medium tabular-nums hover:bg-surface-2',
                    today && 'bg-primary text-primary-fg hover:bg-primary-hover',
                    !isSameMonth(d, anchor) && !today && 'text-subtle',
                  )}
                  title="Open week"
                >
                  {format(d, 'd')}
                </button>
              </div>
              <div className="space-y-px">
                {calls.slice(0, 4).map((c) => (
                  <button
                    key={c.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCall(c);
                    }}
                    className={cn('flex w-full min-w-0 cursor-pointer items-center gap-1 rounded border-l-2 px-1 py-px text-left text-[11px]', CALL_STYLE[c.status] ?? CALL_STYLE.scheduled)}
                    title={`${c.title} · ${c.companyName} · ${c.users.map((u) => u.name).join(', ')}`}
                  >
                    <span className="shrink-0 tabular-nums text-muted">{fmtTime(c.startAt)}</span>
                    <span className="truncate font-medium">{c.title}</span>
                  </button>
                ))}
                {due.shown}
                {more > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDay(d);
                    }}
                    className="cursor-pointer px-1 text-[11px] font-medium text-primary hover:underline"
                  >
                    +{more} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, CalendarDays, CalendarPlus, Clock, Eye, FolderKanban, Inbox, LayoutDashboard, ListTodo, Plus, ShieldAlert, Ticket, UserCheck } from 'lucide-react';
import { TASK_STATUS, formatMinutes } from '@taskora/shared';
import { api, type Paginated } from '@/lib/api';
import { useAuth, useMe } from '@/lib/auth';
import { cn, fmtDate, fmtTime } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/page';
import { DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, Skeleton, Stat } from '@/components/ui/misc';
import { ticketCols, type TicketRow } from '@/components/workspace/tickets';
import { useState } from 'react';
import { ServiceCallDialog } from '@/components/workspace/service-call-dialog';
import { useOpenTicket } from '@/lib/open-ticket';

interface MyWork {
  summary: { open: number; new: number; waiting: number; dueSoon: number; breached: number };
  time: { today: number; week: number };
  tasks: { id: number; title: string; status: string; dueDate: string | null; projectId: number; projectName: string }[];
  serviceCalls: { id: number; title: string; startAt: string; endAt: string; companyName: string }[];
}

const TASK_TONE: Record<string, 'neutral' | 'info' | 'danger' | 'success'> = { todo: 'neutral', in_progress: 'info', blocked: 'danger', done: 'success' };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function MyWorkPage() {
  const me = useMe();
  const { can } = useAuth();
  const navigate = useNavigate();
  const openTicket = useOpenTicket();
  const [scheduling, setScheduling] = useState(false);
  const canTickets = can('tickets.read');

  const work = useQuery({ queryKey: ['my-work'], queryFn: () => api.get<MyWork>('/my-work'), refetchInterval: 60_000 });
  const mine = useQuery({
    queryKey: ['tickets', 'my-open'],
    queryFn: () => api.get<Paginated<TicketRow>>('/tickets', { assignedUserId: 'me', statusCategory: 'open', sort: 'dueAt', order: 'asc', pageSize: 25 }),
    enabled: canTickets,
    refetchInterval: 60_000,
  });
  const watching = useQuery({
    queryKey: ['tickets', 'watching'],
    queryFn: () => api.get<Paginated<TicketRow>>('/tickets', { watching: 'true', statusCategory: 'open', sort: 'updatedAt', order: 'desc', pageSize: 10 }),
    enabled: canTickets,
  });

  const s = work.data?.summary;
  const today = new Date().toDateString();

  return (
    <div>
      <PageHeader
        title="My Work"
        subtitle={`${greeting()}, ${me.user.firstName}. Here is what needs your attention today.`}
        icon={<LayoutDashboard />}
        actions={
          <>
            {can('tickets.write') && (
              <Button onClick={() => setScheduling(true)}>
                <CalendarPlus /> Schedule
              </Button>
            )}
            {can('tickets.write') && (
              <Button variant="primary" onClick={() => navigate('/tickets/new')}>
                <Plus /> New ticket
              </Button>
            )}
          </>
        }
      />
      <PageBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
          {work.isLoading || !s ? (
            Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-[66px]" />)
          ) : (
            <>
              <Stat label="Open" value={s.open} hint="Assigned to me" onClick={canTickets ? () => navigate('/tickets/mine') : undefined} />
              <Stat label="New" value={s.new} hint="Not yet picked up" tone={s.new ? 'warning' : undefined} onClick={canTickets ? () => navigate('/tickets/mine') : undefined} />
              <Stat label="Waiting" value={s.waiting} hint="On customer / vendor" onClick={canTickets ? () => navigate('/tickets/mine') : undefined} />
              <Stat label="Due in 24h" value={s.dueSoon} tone={s.dueSoon ? 'warning' : undefined} hint="Due or SLA deadline" onClick={canTickets ? () => navigate('/tickets/mine') : undefined} />
              <Stat label="SLA breached" value={s.breached} tone={s.breached ? 'danger' : 'success'} hint="Needs action now" onClick={canTickets ? () => navigate('/sla-monitor') : undefined} />
              <Stat label="Time today" value={formatMinutes(work.data!.time.today)} hint="Logged" onClick={can('time.read') ? () => navigate('/time') : undefined} />
              <Stat label="This week" value={formatMinutes(work.data!.time.week)} hint="Logged since Monday" onClick={can('time.read') ? () => navigate('/time') : undefined} />
            </>
          )}
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            {canTickets && (
              <Card className="overflow-hidden">
                <CardHeader
                  title={
                    <span className="inline-flex items-center gap-2">
                      <Ticket className="size-4 text-muted" /> My open tickets
                      {mine.data && <Badge>{mine.data.total}</Badge>}
                    </span>
                  }
                  description="Sorted by due date — most urgent first"
                  actions={
                    <Button size="sm" variant="ghost" onClick={() => navigate('/tickets/mine')}>
                      View all
                    </Button>
                  }
                />
                <DataTable
                  className="max-h-[480px]"
                  columns={[ticketCols.ticket, ticketCols.company, ticketCols.priority, ticketCols.status, ticketCols.sla, ticketCols.due]}
                  data={mine.data?.data}
                  loading={mine.isLoading}
                  onRowClick={(r, e) => openTicket(r.id, e)}
                  empty={<EmptyState icon={<Inbox />} title="Inbox zero" description="No open tickets are assigned to you." />}
                />
                {mine.data && mine.data.total > mine.data.data.length && (
                  <div className="border-t border-border px-4 py-2 text-xs text-muted">
                    Showing {mine.data.data.length} of {mine.data.total}.{' '}
                    <Link to="/tickets/mine" className="text-primary hover:underline">
                      Open the full list
                    </Link>
                  </div>
                )}
              </Card>
            )}

            {canTickets && (
              <Card className="overflow-hidden">
                <CardHeader
                  title={
                    <span className="inline-flex items-center gap-2">
                      <Eye className="size-4 text-muted" /> Tickets I watch
                      {watching.data && <Badge>{watching.data.total}</Badge>}
                    </span>
                  }
                  description="Open tickets you follow, most recently updated first"
                />
                <DataTable
                  className="max-h-[360px]"
                  columns={[ticketCols.ticket, ticketCols.company, ticketCols.assignee, ticketCols.status, ticketCols.sla]}
                  data={watching.data?.data}
                  loading={watching.isLoading}
                  onRowClick={(r, e) => openTicket(r.id, e)}
                  empty={<EmptyState icon={<Eye />} title="Not watching any open tickets" description="Use “Watch” on a ticket to follow its updates here." />}
                />
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader
                title={
                  <span className="inline-flex items-center gap-2">
                    <CalendarDays className="size-4 text-muted" /> Upcoming service calls
                  </span>
                }
                actions={
                  <Button size="sm" variant="ghost" onClick={() => navigate('/calendar')}>
                    Calendar
                  </Button>
                }
              />
              <ul className="divide-y divide-border">
                {work.isLoading && <li className="p-4"><Skeleton className="h-10" /></li>}
                {work.data?.serviceCalls.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted">Nothing scheduled for you.</li>}
                {work.data?.serviceCalls.map((c) => {
                  const start = new Date(c.startAt);
                  const isToday = start.toDateString() === today;
                  return (
                    <li key={c.id}>
                      <Link to="/calendar" className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2">
                        <div className={cn('w-12 shrink-0 rounded-md border px-1 py-0.5 text-center', isToday ? 'border-primary bg-primary-soft text-primary' : 'border-border')}>
                          <div className="text-[10px] font-semibold uppercase">{isToday ? 'Today' : start.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                          <div className="text-sm font-semibold tabular-nums">{start.getDate()}</div>
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium">{c.title}</p>
                          <p className="truncate text-xs text-muted">
                            {fmtTime(c.startAt)}–{fmtTime(c.endAt)} · {c.companyName}
                          </p>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="inline-flex items-center gap-2">
                    <ListTodo className="size-4 text-muted" /> My project tasks
                  </span>
                }
                actions={
                  can('projects.read') && (
                    <Button size="sm" variant="ghost" onClick={() => navigate('/tasks')}>
                      All tasks
                    </Button>
                  )
                }
              />
              <ul className="divide-y divide-border">
                {work.isLoading && <li className="p-4"><Skeleton className="h-10" /></li>}
                {work.data?.tasks.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted">No open tasks assigned to you.</li>}
                {work.data?.tasks.map((t) => {
                  const overdue = t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10);
                  return (
                    <li key={t.id}>
                      <Link to={`/projects/${t.projectId}`} className="flex items-center gap-3 px-4 py-2 hover:bg-surface-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">{t.title}</p>
                          <p className="truncate text-xs text-muted">
                            <FolderKanban className="mr-1 inline size-3" />
                            {t.projectName}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <Badge tone={TASK_TONE[t.status] ?? 'neutral'}>{TASK_STATUS.labels[t.status as keyof typeof TASK_STATUS.labels] ?? t.status}</Badge>
                          <p className={cn('mt-0.5 text-[11px]', overdue ? 'font-medium text-danger' : 'text-muted')}>{t.dueDate ? fmtDate(t.dueDate) : 'No due date'}</p>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Quick links" />
              <div className="grid grid-cols-2 gap-1 p-2">
                {[
                  can('tickets.write') && { to: '/tickets/new', label: 'New ticket', icon: Plus },
                  canTickets && { to: '/tickets/unassigned', label: 'Unassigned', icon: UserCheck },
                  canTickets && { to: '/tickets/queues', label: 'Queues', icon: Inbox },
                  canTickets && { to: '/sla-monitor', label: 'SLA monitor', icon: ShieldAlert },
                  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
                  can('time.read') && { to: '/time', label: 'Timesheet', icon: Clock },
                  can('kb.read') && { to: '/kb', label: 'Knowledge base', icon: BookOpen },
                  can('projects.read') && { to: '/projects', label: 'Projects', icon: FolderKanban },
                ]
                  .filter((x): x is { to: string; label: string; icon: typeof Plus } => !!x)
                  .map((l) => (
                    <Link key={l.to} to={l.to} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] hover:bg-surface-2">
                      <l.icon className="size-4 text-muted" />
                      {l.label}
                    </Link>
                  ))}
              </div>
            </Card>
          </div>
        </div>
      </PageBody>
      <ServiceCallDialog open={scheduling} onOpenChange={setScheduling} />
    </div>
  );
}

import { useOpenLink } from '@/lib/open-ticket';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Bell, BellOff, CalendarDays, Check, CheckCheck, ChevronLeft, ChevronRight, ExternalLink, ListTodo, MessageSquare, Ticket, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Paginated } from '@/lib/api';
import { cn, fmtDateTime, fmtRelative } from '@/lib/utils';
import { useTableState } from '@/hooks/use-table-state';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { EmptyState, Skeleton } from '@/components/ui/misc';
import { Tooltip } from '@/components/ui/overlays';
import { handleFormError } from '@/components/form';
import type { NotificationRow } from '@/components/layout/notification-bell';

const TYPE_ICON: Record<string, typeof Bell> = {
  service_call: CalendarDays,
  'ticket.assigned': UserPlus,
  'task.assigned': ListTodo,
  'ticket.note_added': MessageSquare,
};

function iconFor(type: string) {
  if (TYPE_ICON[type]) return TYPE_ICON[type]!;
  if (type.includes('ticket')) return Ticket;
  return Bell;
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export default function NotificationsPage() {
  const qc = useQueryClient();
  const openLink = useOpenLink();
  const t = useTableState({ pageSize: 30 });
  const unreadOnly = t.filters.unread === 'true';
  const list = useQuery({
    queryKey: ['notifications', 'page', t.page, t.pageSize, unreadOnly],
    queryFn: () => api.get<Paginated<NotificationRow> & { unread: number }>('/notifications', { page: t.page, pageSize: t.pageSize, unread: unreadOnly ? 'true' : undefined }),
    placeholderData: keepPreviousData,
  });

  const markRead = useMutation({
    mutationFn: (id: number) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (e) => handleFormError(e),
  });
  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => {
      toast.success('All notifications marked as read');
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e) => handleFormError(e),
  });

  const open = async (n: NotificationRow) => {
    if (!n.readAt) markRead.mutate(n.id);
    if (n.link) openLink(n.link);
  };

  const rows = list.data?.data ?? [];
  const unread = list.data?.unread ?? 0;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / t.pageSize));

  // Group consecutive rows by day for scanning.
  const groups: { label: string; items: NotificationRow[] }[] = [];
  for (const n of rows) {
    const label = dayLabel(n.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Notifications"
        subtitle={unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'You are all caught up'}
        icon={<Bell />}
        actions={
          <Button onClick={() => markAll.mutate()} disabled={!unread} loading={markAll.isPending}>
            <CheckCheck /> Mark all read
          </Button>
        }
      />
      <div className="flex items-center gap-2 border-b border-border bg-surface px-5 py-2">
        <div className="inline-flex rounded-md border border-border-strong p-0.5">
          {[
            { v: '', label: 'All' },
            { v: 'true', label: `Unread${unread ? ` (${unread})` : ''}` },
          ].map((o) => (
            <button
              key={o.v}
              onClick={() => t.setFilter('unread', o.v)}
              className={cn('cursor-pointer rounded px-2.5 py-1 text-xs font-medium', (t.filters.unread ?? '') === o.v ? 'bg-primary-soft text-primary' : 'text-muted hover:text-foreground')}
            >
              {o.label}
            </button>
          ))}
        </div>
        {total > 0 && (
          <div className="ml-auto flex items-center gap-1 text-xs text-muted">
            <span className="tabular-nums">
              {(t.page - 1) * t.pageSize + 1}–{Math.min(total, t.page * t.pageSize)} of {total}
            </span>
            <Button size="icon-sm" variant="ghost" disabled={t.page <= 1} onClick={() => t.setPage(t.page - 1)} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <Button size="icon-sm" variant="ghost" disabled={t.page >= pages} onClick={() => t.setPage(t.page + 1)} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface scrollbar-thin">
        {list.isLoading && (
          <div className="space-y-2 p-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}
        {!list.isLoading && rows.length === 0 && (
          <EmptyState
            icon={<BellOff />}
            title={unreadOnly ? 'No unread notifications' : 'No notifications yet'}
            description="Assignments, mentions, customer replies and scheduled service calls will show up here."
          />
        )}
        {groups.map((g) => (
          <section key={g.label}>
            <h3 className="sticky top-0 z-10 border-b border-border bg-surface-2 px-5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.label}</h3>
            <ul>
              {g.items.map((n) => {
                const Icon = iconFor(n.type);
                return (
                  <li
                    key={n.id}
                    className={cn('group flex items-start gap-3 border-b border-border px-5 py-2.5 transition-colors hover:bg-surface-2', !n.readAt && 'bg-primary-soft/30', n.link && 'cursor-pointer')}
                    onClick={() => open(n)}
                  >
                    <div className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', n.readAt ? 'bg-surface-2 text-muted' : 'bg-primary-soft text-primary')}>
                      <Icon className="size-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {!n.readAt && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                        <p className={cn('truncate text-[13px]', n.readAt ? 'text-foreground' : 'font-semibold')}>{n.title}</p>
                      </div>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{/^\d{4}-\d{2}-\d{2}T/.test(n.body) ? fmtDateTime(n.body) : n.body}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Tooltip content={fmtDateTime(n.createdAt)}>
                        <span className="text-[11px] text-subtle">{fmtRelative(n.createdAt)}</span>
                      </Tooltip>
                      {!n.readAt && (
                        <Tooltip content="Mark as read">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Mark as read"
                            onClick={(e) => {
                              e.stopPropagation();
                              markRead.mutate(n.id);
                            }}
                          >
                            <Check />
                          </Button>
                        </Tooltip>
                      )}
                      {n.link && <ExternalLink className="size-3.5 text-subtle opacity-0 group-hover:opacity-100" />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

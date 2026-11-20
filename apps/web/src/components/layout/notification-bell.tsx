import { useNavigate } from 'react-router-dom';
import { useOpenLink } from '@/lib/open-ticket';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import { cn, fmtRelative } from '@/lib/utils';
import { translate as t } from '@/lib/i18n';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/overlays';

export interface NotificationRow {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const openLink = useOpenLink();
  const count = useQuery({ queryKey: ['notifications', 'count'], queryFn: () => api.get<{ unread: number }>('/notifications/unread-count'), refetchInterval: 30_000 });
  const list = useQuery({ queryKey: ['notifications', 'recent'], queryFn: () => api.get<Paginated<NotificationRow>>('/notifications', { pageSize: 12 }), enabled: false });
  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const open = async (n: NotificationRow) => {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`);
    qc.invalidateQueries({ queryKey: ['notifications'] });
    if (n.link) openLink(n.link);
  };
  const unread = count.data?.unread ?? 0;
  return (
    <Popover onOpenChange={(o) => o && list.refetch()}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('Notifications ({count} unread)', { count: unread })} className="relative">
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] font-bold text-white">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold">{t('Notifications')}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => markAll.mutate()} disabled={!unread}>
              <CheckCheck /> Mark all read
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate('/notifications')}>
              View all
            </Button>
          </div>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {(list.data?.data ?? []).length === 0 && <p className="px-3 py-6 text-center text-xs text-muted">{t("You're all caught up.")}</p>}
          {list.data?.data.map((n) => (
            <button key={n.id} onClick={() => open(n)} className={cn('block w-full cursor-pointer border-b border-border px-3 py-2 text-left hover:bg-surface-2', !n.readAt && 'bg-primary-soft/40')}>
              <div className="flex items-start gap-2">
                {!n.readAt && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />}
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{n.title}</p>
                  {n.body && <p className="line-clamp-2 text-xs text-muted">{n.body}</p>}
                  <p className="mt-0.5 text-[11px] text-subtle">{fmtRelative(n.createdAt)}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { translate as t } from '@/lib/i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/misc';
import { Dialog } from '../ui/overlays';

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

function describeAgent(ua: string | null) {
  if (!ua) return t('Unknown device');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? t('{browser} on {os}', { browser, os }) : browser;
}

export function SessionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['my-sessions'], queryFn: () => api.get<{ data: SessionRow[] }>('/auth/sessions'), enabled: open });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success(t('Signed out'));
      qc.invalidateQueries({ queryKey: ['my-sessions'] });
    },
  });
  const others = (q.data?.data ?? []).filter((s) => !s.current).length;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Active sessions"
      description="Devices currently signed in to your account"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="danger" disabled={!others} loading={revoke.isPending} onClick={() => revoke.mutate('others')}>
            Sign out all other sessions
          </Button>
        </>
      }
    >
      <ul className="divide-y divide-border">
        {(q.data?.data ?? []).map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2.5 text-[13px]">
            <Laptop className="size-4 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {describeAgent(s.userAgent)} {s.current && <Badge tone="success">{t('This device')}</Badge>}
              </div>
              <div className="text-xs text-muted" title={t('Signed in {date}', { date: fmtDateTime(s.createdAt) })}>
                {s.ip ?? t('unknown IP')} · {t('active {when}', { when: fmtRelative(s.lastSeenAt) })} · {t('expires {when}', { when: fmtRelative(s.expiresAt) })}
              </div>
            </div>
            {!s.current && (
              <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)} aria-label={t('Sign out session')}>
                <LogOut /> Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

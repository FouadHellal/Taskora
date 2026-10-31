import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge, Card, CardBody, CardHeader, PageLoader, Stat } from '../ui/misc';

interface Health {
  version: string;
  node: string;
  uptimeSeconds: number;
  database: { version: string; sizeBytes: number; migrations: number };
  worker: { lastJobFinishedAt: string | null; alive: boolean };
  jobs: { type: string; status: string; n: number }[];
  failedJobs: { id: number; type: string; attempts: number; lastError: string | null; finishedAt: string | null }[];
  mail: { smtp: boolean; imap: boolean };
  integrations: { provider: string; enabled: boolean; status: string; lastSuccessAt: string | null; lastError: string | null }[];
}

/** Operational status for administrators maintaining a self-hosted instance. */
export function SystemHealth() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system-health'], queryFn: () => api.get<Health>('/admin/system-health'), refetchInterval: 30_000 });
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/admin/jobs/${id}/retry`),
    onSuccess: () => {
      toast.success('Job queued again');
      qc.invalidateQueries({ queryKey: ['system-health'] });
    },
  });
  if (!q.data) return <PageLoader />;
  const h = q.data;
  const pending = h.jobs.filter((j) => j.status === 'pending').reduce((a, j) => a + j.n, 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Version" value={h.version} hint={`Node ${h.node}`} />
        <Stat label="API uptime" value={`${Math.floor(h.uptimeSeconds / 3600)} h ${Math.floor((h.uptimeSeconds % 3600) / 60)} m`} />
        <Stat label="Worker" value={h.worker.alive ? 'Running' : 'Not seen'} tone={h.worker.alive ? 'success' : 'danger'} hint={h.worker.lastJobFinishedAt ? `last job ${fmtRelative(h.worker.lastJobFinishedAt)}` : 'no job processed yet'} />
        <Stat label="Database" value={`${(h.database.sizeBytes / 1024 / 1024).toFixed(1)} MB`} hint={`${h.database.version} · ${h.database.migrations} migrations`} />
        <Stat label="Queued jobs" value={pending} />
        <Stat label="Failed jobs" value={h.failedJobs.length} tone={h.failedJobs.length ? 'warning' : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connections" />
          <CardBody className="space-y-2 text-[13px]">
            <div className="flex justify-between">
              <span className="text-muted">Outbound e-mail (SMTP)</span>
              <Badge tone={h.mail.smtp ? 'success' : 'neutral'}>{h.mail.smtp ? 'configured' : 'off'}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Inbound e-mail (IMAP)</span>
              <Badge tone={h.mail.imap ? 'success' : 'neutral'}>{h.mail.imap ? 'configured' : 'off'}</Badge>
            </div>
            {h.integrations.map((i) => (
              <div key={i.provider} className="flex justify-between" title={i.lastError ?? undefined}>
                <span className="text-muted">{i.provider}</span>
                <Badge tone={!i.enabled ? 'neutral' : i.status === 'ok' ? 'success' : 'danger'}>{i.enabled ? `${i.status}${i.lastSuccessAt ? ` · ${fmtRelative(i.lastSuccessAt)}` : ''}` : 'disabled'}</Badge>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Jobs by type" />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <tbody>
                {h.jobs.map((j) => (
                  <tr key={`${j.type}-${j.status}`} className="border-t border-border">
                    <td className="px-4 py-1.5 font-mono text-[12px]">{j.type}</td>
                    <td className="px-4 py-1.5">
                      <Badge tone={j.status === 'failed' ? 'danger' : j.status === 'done' ? 'success' : 'info'}>{j.status}</Badge>
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{j.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      {h.failedJobs.length > 0 && (
        <Card>
          <CardHeader title="Failed jobs" />
          <ul className="divide-y divide-border">
            {h.failedJobs.map((j) => (
              <li key={j.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
                <span className="font-mono text-[12px]">{j.type}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-danger" title={j.lastError ?? ''}>
                  {j.lastError}
                </span>
                <span className="text-xs text-muted">{fmtDateTime(j.finishedAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => retry.mutate(j.id)}>
                  <RotateCcw /> Retry
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Wifi, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { translate as t } from '@/lib/i18n';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { Badge, Card, CardBody, CardHeader, Stat } from './ui/misc';

interface OmadaClientRow {
  id: number;
  mac: string;
  name: string | null;
  hostName: string | null;
  ipAddress: string | null;
  vendor: string | null;
  osName: string | null;
  wireless: boolean;
  ssid: string | null;
  rssi: number | null;
  signalLevel: number | null;
  channel: number | null;
  rxRate: number | null;
  txRate: number | null;
  trafficDown: number | null;
  trafficUp: number | null;
  uptimeSeconds: number | null;
  switchPort: string | null;
  guest: boolean;
  active: boolean;
  lastSeenAt: string | null;
}
interface OmadaPanelData {
  linked: boolean;
  siteName?: string | null;
  device?: {
    mac: string;
    kind: string;
    name: string | null;
    model: string | null;
    firmwareVersion: string | null;
    ipAddress: string | null;
    status: string | null;
    statusDetail: string | null;
    uptimeSeconds: number | null;
    cpuUtil: number | null;
    memUtil: number | null;
    clientCount: number | null;
    clientCount2g: number | null;
    clientCount5g: number | null;
    clientCount6g: number | null;
    uplinkDeviceName: string | null;
    uplinkPort: string | null;
    linkSpeed: string | null;
    lastSeenAt: string | null;
    lastSyncedAt: string;
    missingSince: string | null;
  };
  clients?: OmadaClientRow[];
}

const mac = (m: string) => (m.length === 12 ? m.toUpperCase().match(/../g)!.join(':') : m);
function bytes(n: number | null) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}
function duration(s: number | null) {
  if (!s) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
const signal = (rssi: number | null) => (rssi === null ? null : rssi >= -60 ? 'success' : rssi >= -70 ? 'warning' : 'danger');

/** Live Omada state of a device (access point, switch, gateway) and its clients; renders nothing when the CI is not an Omada device. */
export function OmadaPanel({ ciId }: { ciId: number }) {
  const q = useQuery({ queryKey: ['ci-omada', ciId], queryFn: () => api.get<OmadaPanelData>(`/configuration-items/${ciId}/omada`) });
  if (!q.data?.linked || !q.data.device) return null;
  const d = q.data.device;
  const clients = q.data.clients ?? [];
  const online = clients.filter((c) => c.active);
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            {d.status === 'online' ? <Wifi className="size-4 text-success" /> : <WifiOff className="size-4 text-danger" />} TP-Link Omada
            {d.missingSince ? <Badge>{t('Not reported')}</Badge> : d.status === 'online' ? <Badge tone="success">{d.statusDetail ?? t('Online')}</Badge> : <Badge tone="danger">{d.statusDetail ?? t('Offline')}</Badge>}
          </span>
        }
        description={`${q.data.siteName ?? ''} · ${t('synchronised {when}', { when: fmtRelative(d.lastSyncedAt) })}`}
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <Stat label="Clients" value={online.length} hint={d.clientCount2g !== null || d.clientCount5g !== null ? `2.4 GHz ${d.clientCount2g ?? 0} · 5 GHz ${d.clientCount5g ?? 0}${d.clientCount6g ? ` · 6 GHz ${d.clientCount6g}` : ''}` : undefined} />
          <Stat label="Uptime" value={duration(d.uptimeSeconds)} />
          <Stat label="CPU" value={d.cpuUtil !== null ? `${d.cpuUtil}%` : '—'} tone={(d.cpuUtil ?? 0) > 85 ? 'warning' : undefined} />
          <Stat label="Memory" value={d.memUtil !== null ? `${d.memUtil}%` : '—'} tone={(d.memUtil ?? 0) > 90 ? 'warning' : undefined} />
          <Stat label="Firmware" value={d.firmwareVersion ?? '—'} />
          <Stat label="Uplink" value={d.uplinkDeviceName ? `${d.uplinkDeviceName}${d.uplinkPort ? ` #${d.uplinkPort}` : ''}` : '—'} hint={d.linkSpeed ?? undefined} />
        </div>
        <div className="text-[12px] text-muted">
          {d.model} · {mac(d.mac)} · {d.ipAddress ?? '—'}
          {d.lastSeenAt && <span title={fmtDateTime(d.lastSeenAt)}> · {t('last seen {when}', { when: fmtRelative(d.lastSeenAt) })}</span>}
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">{t('Client')}</th>
                <th className="px-3 py-1.5 font-medium">IP</th>
                <th className="px-3 py-1.5 font-medium">{d.kind === 'ap' ? 'SSID' : t('Port')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Signal')}</th>
                <th className="px-3 py-1.5 text-right font-medium">{t('Down / up')}</th>
                <th className="px-3 py-1.5 font-medium">{t('Connected')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {clients.map((c) => (
                <tr key={c.id} className={c.active ? undefined : 'opacity-50'}>
                  <td className="px-3 py-1.5">
                    <div className="font-medium">{c.hostName ?? c.name ?? mac(c.mac)}</div>
                    <div className="text-[11px] text-muted">
                      {[c.vendor, c.osName, mac(c.mac)].filter(Boolean).join(' · ')}
                      {c.guest && ` · ${t('guest')}`}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 font-mono">{c.ipAddress ?? '—'}</td>
                  <td className="px-3 py-1.5">{c.wireless ? `${c.ssid ?? '—'}${c.channel ? ` · ch ${c.channel}` : ''}` : (c.switchPort ?? '—')}</td>
                  <td className="px-3 py-1.5">{c.rssi !== null ? <Badge tone={signal(c.rssi) as never}>{c.rssi} dBm</Badge> : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {bytes(c.trafficDown)} / {bytes(c.trafficUp)}
                  </td>
                  <td className="px-3 py-1.5">{c.active ? duration(c.uptimeSeconds) : c.lastSeenAt ? t('last seen {when}', { when: fmtRelative(c.lastSeenAt) }) : '—'}</td>
                </tr>
              ))}
              {!clients.length && (
                <tr>
                  <td colSpan={6} className="px-3 py-3 text-center text-muted">
                    {t('No client connected at the last synchronisation.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  );
}

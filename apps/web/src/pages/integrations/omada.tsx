import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RefreshCw, Router, Wifi, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { translate as t } from '@/lib/i18n';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageLoader, Stat } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { FormField, FormGrid, handleFormError } from '@/components/form';
import { EntityPicker } from '@/components/entity-picker';
import { Switch } from '@/components/admin/switch';

type Kind = 'ap' | 'switch' | 'gateway';
interface OmadaView {
  enabled: boolean;
  baseUrl: string;
  omadacId: string;
  verifyTls: boolean;
  syncIntervalMinutes: number;
  autoCreateCis: boolean;
  deviceKinds: Kind[];
  hasCredentials: boolean;
  clientIdHint: string | null;
  credentialsError: string | null;
  status: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextSyncAt: string | null;
  counts: { sites: number; mappedSites: number; devices: number; online: number; clients: number };
  latestRun: { status: string; startedAt: string; stats: Record<string, number>; log: { level: string; message: string }[]; error: string | null } | null;
}
interface Site {
  id: number;
  siteId: string;
  name: string;
  companyId: number | null;
  companyName: string | null;
  enabled: boolean;
  deviceCount: number;
  clientCount: number;
  lastSyncedAt: string | null;
}
interface Device {
  id: number;
  mac: string;
  kind: string;
  name: string | null;
  model: string | null;
  ipAddress: string | null;
  firmwareVersion: string | null;
  status: string | null;
  statusDetail: string | null;
  clientCount: number | null;
  activeClients: number;
  siteName: string | null;
  companyName: string | null;
  configurationItemId: number | null;
  ciName: string | null;
  missingSince: string | null;
  lastSeenAt: string | null;
}

const KIND_LABEL: Record<string, string> = { ap: 'Access point', switch: 'Switch', gateway: 'Gateway', other: 'Other' };

export const fmtMac = (m: string) => (m.length === 12 ? m.toUpperCase().match(/../g)!.join(':') : m);

export default function OmadaPage() {
  const { can } = useAuth();
  const manage = can('integrations.manage');
  const q = useQuery({ queryKey: ['omada'], queryFn: () => api.get<OmadaView>('/integrations/omada'), refetchInterval: 30_000 });
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.post<{ status: string; stats: Record<string, number>; error?: string }>('/integrations/omada/sync?inline=true', {}),
    onSuccess: (r) => {
      if (r.status === 'success') toast.success(t('Synchronised: {devices} device(s), {clients} client(s)', { devices: r.stats.devices ?? 0, clients: r.stats.clients ?? 0 }));
      else toast.error(r.error ?? t('Synchronisation failed'));
      qc.invalidateQueries({ queryKey: ['omada'] });
      qc.invalidateQueries({ queryKey: ['omada-sites'] });
      qc.invalidateQueries({ queryKey: ['omada-devices'] });
    },
    onError: (e) => handleFormError(e),
  });
  if (!q.data) return <PageLoader />;
  const v = q.data;
  return (
    <div>
      <PageHeader
        title="TP-Link Omada"
        icon={<Wifi />}
        subtitle="Access points (and optionally switches and gateways) from the Omada controller become configuration items, with their status and connected clients"
        actions={
          manage && (
            <Button variant="primary" loading={sync.isPending} disabled={!v.hasCredentials || !v.baseUrl} onClick={() => sync.mutate()}>
              <RefreshCw /> Synchronise now
            </Button>
          )
        }
      />
      <div className="space-y-4 p-4 sm:p-5">
        <Card>
          <CardBody>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Status" value={v.enabled ? (v.status === 'connected' ? t('Connected') : v.status === 'error' ? t('Error') : t('Pending')) : t('Disabled')} tone={v.status === 'error' ? 'danger' : v.status === 'connected' && v.enabled ? 'success' : undefined} />
              <Stat label="Sites mapped" value={`${v.counts.mappedSites} / ${v.counts.sites}`} tone={v.counts.sites && !v.counts.mappedSites ? 'warning' : undefined} />
              <Stat label="Devices" value={v.counts.devices} />
              <Stat label="Online" value={v.counts.online} tone="success" />
              <Stat label="Clients connected" value={v.counts.clients} />
              <Stat label="Last success" value={v.lastSuccessAt ? fmtRelative(v.lastSuccessAt) : '—'} />
            </div>
            {v.lastError && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{t('Last error')}: {v.lastError}</p>}
            {v.credentialsError && <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">{v.credentialsError}</p>}
            {v.latestRun?.log.some((l) => l.level === 'info' && l.message.startsWith('No site')) && (
              <p className="mt-3 rounded-md bg-info-soft px-3 py-2 text-xs text-info">{t('Map each Omada site to a company (tab “Sites”), then synchronise again.')}</p>
            )}
          </CardBody>
        </Card>
        <Tabs defaultValue={v.hasCredentials ? 'devices' : 'settings'}>
          <TabsList>
            <TabsTrigger value="devices">Devices</TabsTrigger>
            <TabsTrigger value="sites">Sites</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="devices" className="mt-4">
            <Devices />
          </TabsContent>
          <TabsContent value="sites" className="mt-4">
            <Sites manage={manage} />
          </TabsContent>
          <TabsContent value="settings" className="mt-4">
            <Settings view={v} manage={manage} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function Settings({ view, manage }: { view: OmadaView; manage: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ ...view, clientId: '', clientSecret: '' });
  const [test, setTest] = useState<{ ok: boolean; error?: string; controllerVersion?: string | null; sites?: { id: string; name: string }[] } | null>(null);
  useEffect(() => setF((x) => ({ ...view, clientId: x.clientId, clientSecret: x.clientSecret })), [view]);
  const body = () => ({
    enabled: f.enabled,
    baseUrl: f.baseUrl,
    omadacId: f.omadacId,
    verifyTls: f.verifyTls,
    syncIntervalMinutes: f.syncIntervalMinutes,
    autoCreateCis: f.autoCreateCis,
    deviceKinds: f.deviceKinds,
    ...(f.clientId ? { clientId: f.clientId } : {}),
    ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}),
  });
  const save = useMutation({
    mutationFn: () => api.put('/integrations/omada', body()),
    onSuccess: () => {
      toast.success(t('Omada settings saved'));
      setF((x) => ({ ...x, clientId: '', clientSecret: '' }));
      qc.invalidateQueries({ queryKey: ['omada'] });
    },
    onError: (e) => handleFormError(e),
  });
  const tryIt = useMutation({
    mutationFn: () => api.post<NonNullable<typeof test>>('/integrations/omada/test', body()),
    onSuccess: setTest,
    onError: (e) => setTest({ ok: false, error: e instanceof ApiError ? e.message : 'Connection failed' }),
  });
  const kind = (k: Kind, label: string) => (
    <Checkbox
      label={t(label)}
      checked={f.deviceKinds.includes(k)}
      disabled={!manage}
      onChange={(e) => setF({ ...f, deviceKinds: e.target.checked ? [...f.deviceKinds, k] : f.deviceKinds.filter((x) => x !== k) })}
    />
  );
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card>
        <CardHeader title="Connection" />
        <CardBody className="space-y-4">
          <Checkbox label={t('Synchronise with the Omada controller')} checked={f.enabled} disabled={!manage} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          <FormGrid cols={2}>
            <FormField label="Controller address" required hint="On-premise: https://IP-or-name:8043 (OC200/OC300 often :443). Must be reachable from the Taskora server.">
              <Input value={f.baseUrl} disabled={!manage} placeholder="https://192.168.0.10:8043" onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
            </FormField>
            <FormField label="Omada ID" hint="Optional: read from the controller automatically.">
              <Input value={f.omadacId} disabled={!manage} onChange={(e) => setF({ ...f, omadacId: e.target.value })} />
            </FormField>
            <FormField label="Client ID" hint={view.clientIdHint ? `${t('Stored')} (${view.clientIdHint}) — ${t('leave empty to keep it')}` : undefined}>
              <Input value={f.clientId} disabled={!manage} autoComplete="off" onChange={(e) => setF({ ...f, clientId: e.target.value })} />
            </FormField>
            <FormField label="Client secret" hint={view.hasCredentials ? t('Stored (encrypted) — leave empty to keep it') : undefined}>
              <Input type="password" value={f.clientSecret} disabled={!manage} autoComplete="new-password" onChange={(e) => setF({ ...f, clientSecret: e.target.value })} />
            </FormField>
          </FormGrid>
          <div>
            <Checkbox label={t('Verify the TLS certificate')} checked={f.verifyTls} disabled={!manage} onChange={(e) => setF({ ...f, verifyTls: e.target.checked })} />
            <p className="ml-6 mt-0.5 text-xs text-muted">{t('Leave unticked for controllers with their factory (self-signed) certificate.')}</p>
          </div>
          <FormGrid cols={2}>
            <FormField label="Synchronise every (minutes)">
              <Input type="number" min={5} max={1440} value={f.syncIntervalMinutes} disabled={!manage} onChange={(e) => setF({ ...f, syncIntervalMinutes: Number(e.target.value) || 15 })} />
            </FormField>
            <FormField label="Devices that become configuration items">
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1.5">
                {kind('ap', 'Access points')}
                {kind('switch', 'Switches')}
                {kind('gateway', 'Gateways')}
              </div>
            </FormField>
          </FormGrid>
          <div>
            <Checkbox label={t('Create a configuration item for new devices')} checked={f.autoCreateCis} disabled={!manage} onChange={(e) => setF({ ...f, autoCreateCis: e.target.checked })} />
            <p className="ml-6 mt-0.5 text-xs text-muted">{t('Existing CIs are matched first by MAC address, then serial number, then name, within the company of the site.')}</p>
          </div>
          {manage && (
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Save
              </Button>
              <Button loading={tryIt.isPending} onClick={() => tryIt.mutate()}>
                Test connection
              </Button>
            </div>
          )}
          {test && (
            <div className={`rounded-md px-3 py-2 text-xs ${test.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}>
              {test.ok ? (
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="size-4" />
                  {t('Connected to controller {v}: {n} site(s) — {names}', { v: test.controllerVersion ?? '?', n: test.sites?.length ?? 0, names: (test.sites ?? []).map((s) => s.name).join(', ') })}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <XCircle className="size-4" /> {test.error}
                </span>
              )}
            </div>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="How to create the API access in Omada" />
        <CardBody className="space-y-2 text-[13px]">
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>{t('In the Omada controller, open Global View → Settings → Platform Integration → Open API.')}</li>
            <li>{t('Click Add New App, give it a name (e.g. Taskora) and choose the mode “Client” (client credentials). Leave the Redirect URL empty.')}</li>
            <li>{t('Give the app read access to the sites you want (Viewer is enough: Taskora never changes anything).')}</li>
            <li>{t('Copy the Client ID and the Client Secret into this page, with the controller address, then click Test connection.')}</li>
            <li>{t('Save, map each Omada site to its company in the Sites tab and synchronise.')}</li>
          </ol>
          <p className="text-xs text-muted">{t('Taskora only reads from Omada. Devices that disappear are flagged, never deleted.')}</p>
        </CardBody>
      </Card>
    </div>
  );
}

function Sites({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['omada-sites'], queryFn: () => api.get<Site[]>('/integrations/omada/sites') });
  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: number; companyId?: number | null; enabled?: boolean }) => api.patch(`/integrations/omada/sites/${id}`, body),
    onSuccess: () => {
      toast.success(t('Saved'));
      qc.invalidateQueries({ queryKey: ['omada-sites'] });
      qc.invalidateQueries({ queryKey: ['omada'] });
    },
    onError: (e) => handleFormError(e),
  });
  if (!q.data) return <PageLoader />;
  if (!q.data.length) return <EmptyState icon={<Router />} title="No sites yet" description="Save the connection settings and synchronise once: the sites of the controller appear here." />;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead className="border-b border-border bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">{t('Omada site')}</th>
            <th className="px-3 py-2 font-medium">{t('Company')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('Devices')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('Clients')}</th>
            <th className="px-3 py-2 font-medium">{t('Synchronised')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {q.data.map((site) => (
            <tr key={site.id}>
              <td className="px-3 py-2 font-medium">{site.name}</td>
              <td className="w-72 px-3 py-2">
                {manage ? <EntityPicker kind="company" value={site.companyId} onChange={(id) => patch.mutate({ id: site.id, companyId: id })} /> : (site.companyName ?? '—')}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{site.deviceCount}</td>
              <td className="px-3 py-2 text-right tabular-nums">{site.clientCount}</td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <Switch checked={site.enabled} disabled={!manage} onChange={(v) => patch.mutate({ id: site.id, enabled: v })} label={undefined} />
                  <span className="text-[11px] text-muted">{site.lastSyncedAt ? fmtRelative(site.lastSyncedAt) : '—'}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Devices() {
  const q = useQuery({ queryKey: ['omada-devices'], queryFn: () => api.get<Device[]>('/integrations/omada/devices') });
  if (!q.data) return <PageLoader />;
  if (!q.data.length) return <EmptyState icon={<Wifi />} title="No devices yet" description="Devices of the sites mapped to a company appear here after a synchronisation." />;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-[13px]">
        <thead className="border-b border-border bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">{t('Device')}</th>
            <th className="px-3 py-2 font-medium">{t('Company / site')}</th>
            <th className="px-3 py-2 font-medium">{t('Status')}</th>
            <th className="px-3 py-2 font-medium">IP</th>
            <th className="px-3 py-2 text-right font-medium">{t('Clients')}</th>
            <th className="px-3 py-2 font-medium">{t('Configuration item')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {q.data.map((d) => (
            <tr key={d.id} className={d.missingSince ? 'opacity-60' : undefined}>
              <td className="px-3 py-2">
                <div className="font-medium">{d.name ?? fmtMac(d.mac)}</div>
                <div className="text-[11px] text-muted">
                  {t(KIND_LABEL[d.kind] ?? d.kind)} · {d.model ?? '—'} · {fmtMac(d.mac)}
                </div>
              </td>
              <td className="px-3 py-2">
                {d.companyName ?? '—'}
                <div className="text-[11px] text-muted">{d.siteName}</div>
              </td>
              <td className="px-3 py-2">
                {d.missingSince ? (
                  <Badge>{t('Not reported')}</Badge>
                ) : d.status === 'online' ? (
                  <Badge tone="success">{t('Online')}</Badge>
                ) : d.status === 'pending' ? (
                  <Badge tone="warning">{d.statusDetail ?? t('Pending')}</Badge>
                ) : (
                  <Badge tone="danger">{d.statusDetail ?? t('Offline')}</Badge>
                )}
                {d.lastSeenAt && <div className="text-[11px] text-muted" title={fmtDateTime(d.lastSeenAt)}>{fmtRelative(d.lastSeenAt)}</div>}
              </td>
              <td className="px-3 py-2 font-mono text-[12px]">{d.ipAddress ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{d.activeClients}</td>
              <td className="px-3 py-2">
                {d.configurationItemId ? (
                  <Link to={`/assets/${d.configurationItemId}`} className="text-primary hover:underline">
                    {d.ciName}
                  </Link>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, KeyRound, RefreshCw, Router, Server, Wifi, XCircle } from 'lucide-react';
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
interface AgentState {
  lastSeenAt: string | null;
  lastPushAt: string | null;
  version: string | null;
  host: string | null;
  platform: string | null;
  controllerVersion: string | null;
  lastError: string | null;
  latestVersion: string;
}
interface OmadaView {
  enabled: boolean;
  mode: 'agent' | 'direct';
  agent: AgentState;
  agentTokens: { id: number; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; lastUsedIp: string | null }[];
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

/** Omada's cloud Open API hosts (same list as the API). */
const CLOUD_REGIONS = [
  { label: 'Europe', url: 'https://euw1-omada-northbound.tplinkcloud.com' },
  { label: 'United States', url: 'https://use1-omada-northbound.tplinkcloud.com' },
  { label: 'Asia Pacific', url: 'https://aps1-omada-northbound.tplinkcloud.com' },
];

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
          manage &&
          v.mode === 'direct' && (
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
        <Tabs defaultValue={v.hasCredentials || v.agent.lastPushAt ? 'devices' : 'settings'}>
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
      <div className="space-y-4">
      <Card>
        <CardHeader title="Connection" />
        <CardBody className="space-y-4">
          <Checkbox label={t('Synchronise with the Omada controller')} checked={f.enabled} disabled={!manage} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['agent', 'Agent at the site (recommended)', 'A small agent installed next to the controller sends the data to Taskora. Nothing to open on the client network; the Omada keys stay on site.'],
                ['direct', 'Direct connection', 'Taskora calls the controller itself: it must be reachable from the Taskora server (VPN, port forward or Omada cloud-based controller).'],
              ] as const
            ).map(([m, label, hint]) => (
              <button
                key={m}
                type="button"
                disabled={!manage}
                onClick={() => setF({ ...f, mode: m })}
                className={`cursor-pointer rounded-md border p-3 text-left disabled:cursor-not-allowed ${f.mode === m ? 'border-primary bg-primary-soft/40' : 'border-border hover:border-border-strong'}`}
              >
                <div className="text-[13px] font-medium">{t(label)}</div>
                <div className="mt-0.5 text-[11px] text-muted">{t(hint)}</div>
              </button>
            ))}
          </div>
          {f.mode === 'direct' && (
          <>
          <FormGrid cols={2}>
            <FormField label="Open API address" required hint="The “Interface Access Address” shown in Omada → Settings → Platform Integration → Open API. Cloud: pick your region. On-premise: https://IP:8043, reachable from the Taskora server.">
              <Input value={f.baseUrl} disabled={!manage} placeholder="https://euw1-omada-northbound.tplinkcloud.com" onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
              {manage && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {CLOUD_REGIONS.map((r) => (
                    <button
                      key={r.url}
                      type="button"
                      onClick={() => setF({ ...f, baseUrl: r.url, verifyTls: true })}
                      className={`cursor-pointer rounded border px-2 py-0.5 text-[11px] ${f.baseUrl === r.url ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:border-border-strong'}`}
                    >
                      {t('Omada cloud')} — {t(r.label)}
                    </button>
                  ))}
                </div>
              )}
            </FormField>
            <FormField label="Omada ID" required={f.baseUrl.includes('tplinkcloud.com')} hint="Shown on the same Open API page. Required for the Omada cloud; read automatically from an on-premise controller.">
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
          </>
          )}
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
              {f.mode === 'direct' && (
                <Button loading={tryIt.isPending} onClick={() => tryIt.mutate()}>
                  Test connection
                </Button>
              )}
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
      {view.mode === 'agent' && f.mode === 'agent' ? <AgentSetup view={view} manage={manage} /> : null}
      {view.mode !== f.mode && f.mode === 'agent' && <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">{t('Save to set up the site agent.')}</p>}
      </div>
      <Card className="self-start">
        <CardHeader title="How to create the API access in Omada" />
        <CardBody className="space-y-2 text-[13px]">
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>{t('In the Omada controller, open Global View → Settings → Platform Integration → Open API.')}</li>
            <li>{t('Click Add New App, give it a name (e.g. Taskora) and choose the mode “Client” (client credentials). Leave the Redirect URL empty.')}</li>
            <li>{t('Give the app read access to the sites you want (Viewer is enough: Taskora never changes anything).')}</li>
            {f.mode === 'direct' && <li>{t('On the same page, note the Interface Access Address and the Omada ID shown at the top.')}</li>}
            {f.mode === 'agent' ? (
              <li>{t('Keep the Client ID and the Client Secret: the agent installer asks for them on the controller’s machine (they are not sent to Taskora).')}</li>
            ) : (
              <>
                <li>{t('Copy the Client ID and the Client Secret into this page, with the controller address, then click Test connection.')}</li>
                <li>{t('Save, map each Omada site to its company in the Sites tab and synchronise.')}</li>
              </>
            )}
          </ol>
          <p className="text-xs text-muted">{t('Taskora only reads from Omada. Devices that disappear are flagged, never deleted.')}</p>
        </CardBody>
      </Card>
    </div>
  );
}

function CopyBox({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-[12px] font-medium">
        {t(label)}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => toast.success(t('Copied')));
          }}
        >
          <Copy /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed">{text}</pre>
    </div>
  );
}

/** Agent mode: create a token, copy the install command, watch the agent report in. */
function AgentSetup({ view, manage }: { view: OmadaView; manage: boolean }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const origin = window.location.origin;
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>('/integrations/omada/agent/token', {}),
    onSuccess: (r) => {
      setToken(r.token);
      qc.invalidateQueries({ queryKey: ['omada'] });
    },
    onError: (e) => handleFormError(e),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.delete(`/integrations/tokens/${id}`),
    onSuccess: () => {
      toast.success(t('Token revoked'));
      qc.invalidateQueries({ queryKey: ['omada'] });
    },
    onError: (e) => handleFormError(e),
  });
  const tok = token ?? 'PASTE-THE-AGENT-TOKEN';
  const files = `${origin}/api/v1/integrations/omada/agent/files`;
  const windows = `& ([scriptblock]::Create((irm '${files}/install-windows.ps1'))) -TaskoraUrl '${origin}' -Token '${tok}'`;
  const linux = `curl -fsSL ${files}/install-linux.sh | sudo bash -s -- --url ${origin} --token ${tok}`;
  const a = view.agent;
  const seen = a.lastSeenAt ? Date.now() - new Date(a.lastSeenAt).getTime() : null;
  const healthy = seen !== null && seen < (view.syncIntervalMinutes * 2 + 5) * 60_000 && !a.lastError;
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Server className="size-4 text-primary" /> {t('Site agent')}
            {a.lastSeenAt ? healthy ? <Badge tone="success">{t('Connected')}</Badge> : <Badge tone="warning">{a.lastError ? t('Error') : t('Silent')}</Badge> : <Badge>{t('Not installed yet')}</Badge>}
          </span>
        }
        description={t('Runs on the controller’s machine (Windows or Linux) and sends the data every few minutes over HTTPS.')}
      />
      <CardBody className="space-y-4 text-[13px]">
        {a.lastSeenAt && (
          <div className="grid grid-cols-2 gap-2 rounded-md bg-surface-2 p-3 text-[12px]">
            <div>
              <div className="text-muted">{t('Last contact')}</div>
              <div className="font-medium" title={fmtDateTime(a.lastSeenAt)}>{fmtRelative(a.lastSeenAt)}</div>
            </div>
            <div>
              <div className="text-muted">{t('Last data received')}</div>
              <div className="font-medium">{a.lastPushAt ? fmtRelative(a.lastPushAt) : '—'}</div>
            </div>
            <div>
              <div className="text-muted">{t('Machine')}</div>
              <div className="font-medium">{a.host ?? '—'}</div>
            </div>
            <div>
              <div className="text-muted">{t('Agent / controller')}</div>
              <div className="font-medium">
                {a.version ?? '?'}
                {a.version && a.version !== a.latestVersion ? ` (${t('update available')})` : ''} / {a.controllerVersion ?? '?'}
              </div>
            </div>
            {a.lastError && <div className="col-span-2 rounded bg-danger-soft px-2 py-1.5 text-danger">{a.lastError}</div>}
          </div>
        )}
        <ol className="list-decimal space-y-3 pl-5">
          <li>
            <div className="font-medium">{t('Create the agent token')}</div>
            {manage && (
              <Button className="mt-1.5" size="sm" variant={token ? 'secondary' : 'primary'} loading={create.isPending} onClick={() => create.mutate()}>
                <KeyRound /> {token ? t('Create another token') : t('Create the agent token')}
              </Button>
            )}
            {token && <p className="mt-1.5 rounded bg-warning-soft px-2 py-1.5 text-[12px] text-warning">{t('The commands below contain the token. It is shown only now: copy the command before leaving this page.')}</p>}
          </li>
          <li>
            <div className="mb-1.5 font-medium">{t('On the controller’s machine, run the command for its system')}</div>
            <div className="space-y-3">
              <CopyBox label="Windows — PowerShell as Administrator" text={windows} />
              <CopyBox label="Linux — terminal" text={linux} />
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              {t('The installer asks for the Omada Client ID and Client Secret, finds the controller on the machine, tests both connections and installs the agent as a service that starts with the machine. Run it again to update; add -Uninstall (Windows) or --uninstall (Linux) to remove it.')}
            </p>
          </li>
          <li>
            <div className="font-medium">{t('Map each Omada site to its company (Sites tab)')}</div>
            <p className="text-[11px] text-muted">{t('The sites appear after the first contact of the agent; devices and clients arrive at the next run.')}</p>
          </li>
        </ol>
        {view.agentTokens.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] font-medium">{t('Agent tokens')}</div>
            <ul className="divide-y divide-border rounded-md border border-border text-[12px]">
              {view.agentTokens.map((x) => (
                <li key={x.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="font-mono">{x.prefix}…</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{x.lastUsedAt ? t('used {when} from {ip}', { when: fmtRelative(x.lastUsedAt), ip: x.lastUsedIp ?? '?' }) : t('never used')}</span>
                  {manage && (
                    <Button size="sm" variant="ghost" className="text-danger" loading={revoke.isPending && revoke.variables === x.id} onClick={() => revoke.mutate(x.id)}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
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

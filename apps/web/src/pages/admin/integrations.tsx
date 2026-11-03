import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plug, Radar, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ACTION1_REGIONS, SYNC_STATUS } from '@taskora/shared';
import { api, ApiError, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { opts, useLookups } from '@/lib/lookups';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, Field, PageLoader, Stat } from '@/components/ui/misc';
import { Dialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { FormField, FormGrid, handleFormError } from '@/components/form';
import { DataTable, type Column } from '@/components/data-table';
import { EntityPicker } from '@/components/entity-picker';

interface Action1View {
  enabled: boolean;
  region: string;
  syncIntervalMinutes: number;
  autoCreateCis: boolean;
  matchBySerial: boolean;
  matchByHostname: boolean;
  matchContacts: boolean;
  defaultCiTypeId: number | null;
  hasCredentials: boolean;
  clientIdHint: string | null;
  credentialsError: string | null;
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextSyncAt: string | null;
  endpointCounts: Record<string, number>;
}

interface Run {
  id: number;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, number>;
  error: string | null;
  triggeredByName?: string | null;
  log?: { at: string; level: string; message: string }[];
}

interface Org {
  id: number;
  externalId: string;
  name: string;
  companyId: number | null;
  companyName: string | null;
  enabled: boolean;
  endpointTotal: number;
  endpointLinked: number;
  endpointNeedsReview: number;
  lastSyncedAt: string | null;
}

const runTone = (s: string) => (s === 'success' ? 'success' : s === 'partial' ? 'warning' : s === 'failed' ? 'danger' : 'info') as 'success' | 'warning' | 'danger' | 'info';

export default function IntegrationsPage() {
  const { can } = useAuth();
  const manage = can('integrations.manage');
  const q = useQuery({ queryKey: ['action1'], queryFn: () => api.get<Action1View>('/integrations/action1') });
  if (!q.data) return <PageLoader />;
  const a = q.data;
  return (
    <div>
      <PageHeader title="Integrations" icon={<Plug />} subtitle="Connect Taskora to your RMM and other tools" />
      <div className="space-y-4 p-5">
        <AtlasCard />
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                Action1 {a.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
                <Badge tone={a.status === 'ok' ? 'success' : a.status === 'error' ? 'danger' : 'neutral'}>{a.status.replace(/_/g, ' ')}</Badge>
              </span>
            }
            description="Patch management & RMM — discovers endpoints and keeps configuration items up to date"
            actions={
              <Link to="/integrations/action1/endpoints">
                <Button size="sm">Review endpoints</Button>
              </Link>
            }
          />
          <CardBody>
            <div className="mb-4 flex items-start gap-2 rounded-md bg-info-soft px-3 py-2 text-xs text-info">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              Taskora only <b>reads</b> inventory and status from Action1. It never installs software, deploys patches, runs commands, reboots or deletes endpoints.
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
              <Stat label="Endpoints" value={a.endpointCounts.total ?? 0} />
              <Stat label="Linked" value={(a.endpointCounts.matched ?? 0) + (a.endpointCounts.created ?? 0)} tone="success" />
              <Stat label="Need review" value={(a.endpointCounts.unmatched ?? 0) + (a.endpointCounts.conflict ?? 0)} tone={(a.endpointCounts.unmatched ?? 0) + (a.endpointCounts.conflict ?? 0) ? 'warning' : undefined} />
              <Stat label="Unmapped org" value={a.endpointCounts.unmapped_org ?? 0} />
              <Stat label="Not reported" value={a.endpointCounts.missing ?? 0} hint="Absent from last sync" />
              <Stat label="Last success" value={a.lastSuccessAt ? fmtRelative(a.lastSuccessAt) : '—'} />
              <Stat label="Next sync" value={a.enabled && a.nextSyncAt ? fmtRelative(a.nextSyncAt) : '—'} />
            </div>
            {a.lastError && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">Last error: {a.lastError}</p>}
            {a.credentialsError && <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">{a.credentialsError} — re-enter the credentials.</p>}
          </CardBody>
        </Card>

        <Tabs defaultValue="settings">
          <TabsList>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="orgs">Organization mapping</TabsTrigger>
            <TabsTrigger value="runs">Sync history</TabsTrigger>
          </TabsList>
          <TabsContent value="settings" className="mt-4">
            <SettingsForm view={a} manage={manage} />
          </TabsContent>
          <TabsContent value="orgs" className="mt-4">
            <OrgMapping manage={manage} />
          </TabsContent>
          <TabsContent value="runs" className="mt-4">
            <Runs />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function AtlasCard() {
  const q = useQuery({ queryKey: ['atlas'], queryFn: () => api.get<{ settings: { enabled: boolean; cmdbMode: string }; incidents: { open: number; total: number }; status: { lastSuccessAt: string | null } }>('/integrations/atlas/settings') });
  const a = q.data;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Radar className="size-4" /> atlas {a?.settings.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
          </span>
        }
        description="Homelab monitoring — incidents become tickets, observed infrastructure reconciles with the CMDB"
        actions={
          <Link to="/integrations/atlas">
            <Button size="sm">Open</Button>
          </Link>
        }
      />
      {a && (
        <CardBody>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Open incidents" value={a.incidents.open} tone={a.incidents.open ? 'warning' : undefined} />
            <Stat label="Incidents total" value={a.incidents.total} />
            <Stat label="CMDB" value={a.settings.cmdbMode.replace(/_/g, ' ')} />
            <Stat label="Last contact" value={a.status.lastSuccessAt ? fmtRelative(a.status.lastSuccessAt) : '—'} />
          </div>
        </CardBody>
      )}
    </Card>
  );
}

function SettingsForm({ view, manage }: { view: Action1View; manage: boolean }) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const [f, setF] = useState({ ...view, clientId: '', clientSecret: '' });
  useEffect(() => setF({ ...view, clientId: '', clientSecret: '' }), [view]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const payload = () => ({
    enabled: f.enabled,
    region: f.region,
    clientId: f.clientId || undefined,
    clientSecret: f.clientSecret || undefined,
    syncIntervalMinutes: f.syncIntervalMinutes,
    autoCreateCis: f.autoCreateCis,
    matchBySerial: f.matchBySerial,
    matchByHostname: f.matchByHostname,
    matchContacts: f.matchContacts,
    defaultCiTypeId: f.defaultCiTypeId,
  });
  const save = useMutation({
    mutationFn: () => api.put('/integrations/action1', payload()),
    onSuccess: () => {
      toast.success('Action1 settings saved');
      qc.invalidateQueries({ queryKey: ['action1'] });
    },
    onError: (e) => handleFormError(e),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; organizations?: number; error?: string }>('/integrations/action1/test', { region: f.region, clientId: f.clientId || undefined, clientSecret: f.clientSecret || undefined }),
    onSuccess: (r) => (r.ok ? toast.success(`Connected — ${r.organizations} organization(s) visible`) : toast.error(r.error ?? 'Connection failed')),
    onError: (e) => handleFormError(e),
  });
  const sync = useMutation({
    mutationFn: (inline: boolean) => api.post<{ queued?: boolean; reason?: string; status?: string }>(`/integrations/action1/sync${inline ? '?inline=true' : ''}`),
    onSuccess: (r) => {
      if (r.queued === false) toast.message(r.reason ?? 'Already queued');
      else if (r.queued) toast.success('Synchronisation queued — the worker will run it shortly');
      else toast.success(`Synchronisation finished: ${r.status}`);
      qc.invalidateQueries({ queryKey: ['action1'] });
      qc.invalidateQueries({ queryKey: ['action1-runs'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Sync failed'),
  });
  return (
    <Card>
      <CardBody className="space-y-5">
        <FormGrid cols={3}>
          <FormField label="Region">
            <Select disabled={!manage} value={f.region} onChange={(e) => set('region', e.target.value)} options={ACTION1_REGIONS.values.map((v) => ({ value: v, label: ACTION1_REGIONS.labels[v] }))} />
          </FormField>
          <FormField label="Client ID" hint={view.hasCredentials ? `Stored (…${view.clientIdHint ?? ''}) — leave empty to keep` : 'From Action1 → API credentials'}>
            <Input disabled={!manage} value={f.clientId} onChange={(e) => set('clientId', e.target.value)} placeholder={view.hasCredentials ? 'unchanged' : ''} autoComplete="off" />
          </FormField>
          <FormField label="Client secret" hint="Encrypted at rest; never displayed again">
            <Input disabled={!manage} type="password" value={f.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} placeholder={view.hasCredentials ? '•••••••• stored' : ''} autoComplete="new-password" />
          </FormField>
          <FormField label="Sync interval (minutes)">
            <Input disabled={!manage} type="number" min={15} max={1440} value={f.syncIntervalMinutes} onChange={(e) => set('syncIntervalMinutes', Number(e.target.value))} />
          </FormField>
          <FormField label="Default CI type for new devices" hint="Used when the device type cannot be inferred">
            <Select disabled={!manage} value={f.defaultCiTypeId ?? ''} onChange={(e) => set('defaultCiTypeId', e.target.value ? Number(e.target.value) : null)} placeholder="Other" options={opts(lookups.data?.ciTypes)} />
          </FormField>
        </FormGrid>
        <div className="grid gap-2 sm:grid-cols-2">
          <Checkbox disabled={!manage} label="Enable scheduled synchronisation" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <Checkbox disabled={!manage} label="Create configuration items for new endpoints" checked={f.autoCreateCis} onChange={(e) => set('autoCreateCis', e.target.checked)} />
          <Checkbox disabled={!manage} label="Match existing CIs by serial number (same company only)" checked={f.matchBySerial} onChange={(e) => set('matchBySerial', e.target.checked)} />
          <Checkbox disabled={!manage} label="Match existing CIs by hostname (same company, unique only)" checked={f.matchByHostname} onChange={(e) => set('matchByHostname', e.target.checked)} />
          <Checkbox disabled={!manage} label="Assign contacts from the logged-in user when unambiguous" checked={f.matchContacts} onChange={(e) => set('matchContacts', e.target.checked)} />
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save settings
            </Button>
            <Button loading={test.isPending} onClick={() => test.mutate()}>
              Test connection
            </Button>
            <Button loading={sync.isPending} onClick={() => sync.mutate(false)} disabled={!view.hasCredentials}>
              <RefreshCw /> Sync now
            </Button>
            <Button variant="ghost" loading={sync.isPending} onClick={() => sync.mutate(true)} disabled={!view.hasCredentials}>
              Run inline (no worker)
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function OrgMapping({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['action1-orgs'], queryFn: () => api.get<Org[]>('/integrations/action1/organizations') });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch<Org & { warning: { message: string } | null }>(`/integrations/action1/organizations/${id}`, body),
    onSuccess: (r) => {
      if (r.warning) toast.warning(r.warning.message, { duration: 8000 });
      else toast.success('Mapping saved');
      qc.invalidateQueries({ queryKey: ['action1-orgs'] });
      qc.invalidateQueries({ queryKey: ['action1'] });
    },
    onError: (e) => handleFormError(e),
  });
  const cols: Column<Org>[] = [
    { header: 'Action1 organization', cell: ({ row }) => <div><div className="font-medium">{row.original.name}</div><div className="font-mono text-[11px] text-muted">{row.original.externalId}</div></div> },
    {
      header: 'Taskora company',
      cell: ({ row }) =>
        manage ? (
          <div className="w-64">
            <EntityPicker kind="company" value={row.original.companyId} label={row.original.companyName} placeholder="Not mapped" onChange={(id) => patch.mutate({ id: row.original.id, body: { companyId: id, enabled: row.original.enabled } })} />
          </div>
        ) : (
          (row.original.companyName ?? <span className="text-subtle">Not mapped</span>)
        ),
    },
    {
      header: 'Sync',
      cell: ({ row }) => (
        <Checkbox disabled={!manage} checked={row.original.enabled} onChange={(e) => patch.mutate({ id: row.original.id, body: { companyId: row.original.companyId, enabled: e.target.checked } })} />
      ),
    },
    { header: 'Endpoints', meta: { align: 'right' }, cell: ({ row }) => row.original.endpointTotal },
    { header: 'Linked', meta: { align: 'right' }, cell: ({ row }) => row.original.endpointLinked },
    { header: 'To review', meta: { align: 'right' }, cell: ({ row }) => (row.original.endpointNeedsReview ? <span className="font-semibold text-warning">{row.original.endpointNeedsReview}</span> : 0) },
    { header: 'Last synced', cell: ({ row }) => <span className="text-xs text-muted">{fmtRelative(row.original.lastSyncedAt)}</span> },
  ];
  return (
    <Card>
      <CardHeader title="Organization → company mapping" description="Devices are only linked or created for organizations explicitly mapped to a company. Organizations appear after the first sync." />
      <DataTable columns={cols} data={q.data} loading={q.isLoading} />
    </Card>
  );
}

function Runs() {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['action1-runs', page], queryFn: () => api.get<Paginated<Run>>('/integrations/action1/runs', { page, pageSize: 25 }) });
  const detail = useQuery({ queryKey: ['action1-run', open], queryFn: () => api.get<Run>(`/integrations/action1/runs/${open}`), enabled: open !== null });
  const cols: Column<Run>[] = [
    { header: 'Started', cell: ({ row }) => fmtDateTime(row.original.startedAt) },
    { header: 'Trigger', cell: ({ row }) => <Badge>{row.original.trigger}</Badge> },
    { header: 'Status', cell: ({ row }) => <Badge tone={runTone(row.original.status)}>{SYNC_STATUS.labels[row.original.status as keyof typeof SYNC_STATUS.labels] ?? row.original.status}</Badge> },
    { header: 'Duration', cell: ({ row }) => (row.original.finishedAt ? `${Math.max(1, Math.round((new Date(row.original.finishedAt).getTime() - new Date(row.original.startedAt).getTime()) / 1000))} s` : '—') },
    {
      header: 'Result',
      cell: ({ row }) => (
        <span className="text-xs text-muted">
          {Object.entries(row.original.stats ?? {})
            .filter(([, v]) => v)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ') || row.original.error || '—'}
        </span>
      ),
    },
  ];
  return (
    <Card>
      <DataTable columns={cols} data={q.data?.data} total={q.data?.total} page={page} pageSize={25} onPageChange={setPage} loading={q.isLoading} onRowClick={(r) => setOpen(r.id)} />
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={`Sync run #${open}`} size="lg">
        {detail.data && (
          <div className="space-y-4">
            <dl className="grid grid-cols-3 gap-3">
              <Field label="Status">
                <Badge tone={runTone(detail.data.status)}>{detail.data.status}</Badge>
              </Field>
              <Field label="Started">{fmtDateTime(detail.data.startedAt)}</Field>
              <Field label="Triggered by">{detail.data.triggeredByName ?? detail.data.trigger}</Field>
              {Object.entries(detail.data.stats ?? {}).map(([k, v]) => (
                <Field key={k} label={k}>
                  {v}
                </Field>
              ))}
            </dl>
            {detail.data.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{detail.data.error}</p>}
            <div className="max-h-80 overflow-y-auto rounded-md bg-surface-2 p-3 font-mono text-[11px]">
              {(detail.data.log ?? []).map((l, i) => (
                <div key={i} className={l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warning' : ''}>
                  {l.level === 'error' ? <XCircle className="mr-1 inline size-3" /> : <CheckCircle2 className="mr-1 inline size-3 opacity-40" />}
                  {new Date(l.at).toLocaleTimeString()} {l.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

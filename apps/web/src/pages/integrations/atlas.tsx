import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Radar, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { INTEGRATION_SCOPE_KEYS, type AtlasSettings, type IntegrationScope } from '@taskora/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { opts, useLookups, userOpts } from '@/lib/lookups';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, PageLoader, Stat } from '@/components/ui/misc';
import { Dialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { FormField, FormGrid, handleFormError } from '@/components/form';
import { DataTable, type Column } from '@/components/data-table';
import { EntityPicker } from '@/components/entity-picker';
import { freshnessTone, safeHref, severityTone, type AtlasEntity } from '@/components/atlas-panel';

interface Token {
  id: number;
  name: string;
  prefix: string;
  scopes: IntegrationScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface View {
  settings: AtlasSettings;
  status: { status: string; lastSuccessAt: string | null; lastSyncAt: string | null; lastError: string | null };
  incidents: { total: number; open: number };
  tokens: Token[];
  scopes: Record<IntegrationScope, string>;
}

interface IncidentRow {
  externalKey: string;
  title: string;
  state: string;
  severity: string;
  persisting: boolean;
  revision: number;
  lastObservedAt: string;
  resolvedAt: string | null;
  link: string | null;
  ticket: { id: number; number: string; status: string; statusCategory: string; priority: string; assignee: string | null } | null;
}

type EntityRow = AtlasEntity & { ciNumber: string | null; ciName: string | null; configurationItemId: number | null; provenance: string };

const KINDS = ['pve-node', 'pve-vm', 'pve-lxc', 'linux-host', 'nas', 'unifi-switch', 'unifi-ap', 'unifi-gateway', 'client'];
const matchTone = (s: string) => (s === 'conflict' ? 'danger' : s === 'proposed' ? 'warning' : s === 'linked' || s === 'created' ? 'success' : 'neutral') as 'danger' | 'warning' | 'success' | 'neutral';

export default function AtlasIntegrationPage() {
  const { can } = useAuth();
  const manage = can('integrations.manage');
  const q = useQuery({ queryKey: ['atlas'], queryFn: () => api.get<View>('/integrations/atlas/settings') });
  const entities = useQuery({ queryKey: ['atlas-entity-counts'], queryFn: () => api.get<{ counts: Record<string, number> }>('/integrations/atlas/entities', { pageSize: 1 }) });
  if (!q.data) return <PageLoader />;
  const v = q.data;
  const c = entities.data?.counts ?? {};
  const review = (c.conflict ?? 0) + (c.proposed ?? 0);
  return (
    <div>
      <PageHeader title="atlas" icon={<Radar />} subtitle="Homelab monitoring: incidents become tickets, observed infrastructure reconciles with the CMDB" />
      <div className="space-y-4 p-5">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                atlas {v.settings.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
                <Badge>CMDB: {v.settings.cmdbMode.replace(/_/g, ' ')}</Badge>
              </span>
            }
            description="atlas pushes to Taskora with a scoped token; Taskora never connects to atlas"
          />
          <CardBody>
            <div className="mb-4 flex items-start gap-2 rounded-md bg-info-soft px-3 py-2 text-xs text-info">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              atlas owns what it observes (health, placement, network). Action1 owns Action1 fields; your service-desk fields stay yours. A technician closing a ticket never marks infrastructure healthy: only atlas confirms recovery.
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Open incidents" value={v.incidents.open} tone={v.incidents.open ? 'warning' : undefined} />
              <Stat label="Incidents total" value={v.incidents.total} />
              <Stat label="Observed entities" value={Object.values(c).reduce((a, b) => a + b, 0)} />
              <Stat label="To review" value={review} tone={review ? 'warning' : undefined} hint="Conflicts and proposals" />
              <Stat label="Last contact" value={v.status.lastSuccessAt ? fmtRelative(v.status.lastSuccessAt) : '—'} />
            </div>
            {v.status.lastError && <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">Last error: {v.status.lastError}</p>}
          </CardBody>
        </Card>

        <Tabs defaultValue={review ? 'entities' : 'settings'}>
          <TabsList>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="tokens">Tokens</TabsTrigger>
            <TabsTrigger value="incidents">Incidents</TabsTrigger>
            <TabsTrigger value="entities">CMDB reconciliation</TabsTrigger>
            <TabsTrigger value="runs">Sync history</TabsTrigger>
          </TabsList>
          <TabsContent value="settings" className="mt-4">
            <SettingsForm view={v} manage={manage} />
          </TabsContent>
          <TabsContent value="tokens" className="mt-4">
            <Tokens view={v} manage={manage} />
          </TabsContent>
          <TabsContent value="incidents" className="mt-4">
            <Incidents />
          </TabsContent>
          <TabsContent value="entities" className="mt-4">
            <Entities manage={manage} companyId={v.settings.companyId} />
          </TabsContent>
          <TabsContent value="runs" className="mt-4">
            <Runs />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function SettingsForm({ view, manage }: { view: View; manage: boolean }) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const [f, setF] = useState(view.settings);
  useEffect(() => setF(view.settings), [view]);
  const set = <K extends keyof AtlasSettings>(k: K, val: AtlasSettings[K]) => setF((x) => ({ ...x, [k]: val }));
  const num = (v: string) => (v ? Number(v) : null);
  const save = useMutation({
    mutationFn: () => api.put('/integrations/atlas/settings', f),
    onSuccess: () => {
      toast.success('atlas settings saved');
      qc.invalidateQueries({ queryKey: ['atlas'] });
    },
    onError: (e) => handleFormError(e),
  });
  const statuses = lookups.data?.statuses;
  const statusOpts = (cats: string[]) => opts(statuses?.filter((s) => cats.includes(s.category)));
  const prio = opts(lookups.data?.priorities);
  return (
    <Card>
      <CardBody className="space-y-5">
        <FormGrid cols={3}>
          <FormField label="Company" hint="atlas tickets and CIs belong to this company">
            <EntityPicker kind="company" value={f.companyId} onChange={(id) => set('companyId', id)} disabled={!manage} placeholder="Choose the homelab company" />
          </FormField>
          <FormField label="atlas address" hint="Only used for links; Taskora never connects to it">
            <Input disabled={!manage} value={f.atlasBaseUrl ?? ''} onChange={(e) => set('atlasBaseUrl', e.target.value.trim() || null)} placeholder="https://atlas.lan" />
          </FormField>
          <FormField label="Queue">
            <Select disabled={!manage} value={f.queueId ?? ''} onChange={(e) => set('queueId', num(e.target.value))} placeholder="Default" options={opts(lookups.data?.queues)} />
          </FormField>
          <FormField label="Ticket type">
            <Select disabled={!manage} value={f.ticketTypeId ?? ''} onChange={(e) => set('ticketTypeId', num(e.target.value))} placeholder="Default" options={opts(lookups.data?.ticketTypes)} />
          </FormField>
          <FormField label="Source">
            <Select disabled={!manage} value={f.sourceId ?? ''} onChange={(e) => set('sourceId', num(e.target.value))} placeholder="Monitoring Alert" options={opts(lookups.data?.sources)} />
          </FormField>
          <FormField label="Assign to">
            <Select disabled={!manage} value={f.assignedUserId ?? ''} onChange={(e) => set('assignedUserId', num(e.target.value))} placeholder="Unassigned" options={userOpts(lookups.data?.users)} />
          </FormField>
          {(['warning', 'notice', 'info'] as const).map((sev) => (
            <FormField key={sev} label={`Priority for ${sev}`}>
              <Select disabled={!manage} value={f.priorityMap[sev] ?? ''} onChange={(e) => set('priorityMap', { ...f.priorityMap, [sev]: num(e.target.value) })} placeholder="Default" options={prio} />
            </FormField>
          ))}
          <FormField label="When atlas sees recovery">
            <Select disabled={!manage} value={f.recoveryPolicy} onChange={(e) => set('recoveryPolicy', e.target.value as AtlasSettings['recoveryPolicy'])} options={[{ value: 'resolve', label: 'Resolve the ticket' }, { value: 'note', label: 'Add a note only' }]} />
          </FormField>
          <FormField label="Resolved status">
            <Select disabled={!manage} value={f.resolvedStatusId ?? ''} onChange={(e) => set('resolvedStatusId', num(e.target.value))} placeholder="First resolved status" options={statusOpts(['resolved'])} />
          </FormField>
          <FormField label="When it fails again">
            <Select disabled={!manage} value={f.reopenPolicy} onChange={(e) => set('reopenPolicy', e.target.value as AtlasSettings['reopenPolicy'])} options={[{ value: 'reopen', label: 'Reopen the ticket' }, { value: 'note', label: 'Add a note only' }]} />
          </FormField>
          <FormField label="Reopen status">
            <Select disabled={!manage} value={f.reopenStatusId ?? ''} onChange={(e) => set('reopenStatusId', num(e.target.value))} placeholder="First open status" options={statusOpts(['new', 'open'])} />
          </FormField>
          <FormField label="CMDB" hint="Start with link only, review, then allow creation">
            <Select
              disabled={!manage}
              value={f.cmdbMode}
              onChange={(e) => set('cmdbMode', e.target.value as AtlasSettings['cmdbMode'])}
              options={[
                { value: 'off', label: 'Off (observations only)' },
                { value: 'link_only', label: 'Link to existing CIs' },
                { value: 'link_and_create', label: 'Link, and create unmanaged infrastructure' },
              ]}
            />
          </FormField>
          <FormField label="Default CI type">
            <Select disabled={!manage} value={f.defaultCiTypeId ?? ''} onChange={(e) => set('defaultCiTypeId', num(e.target.value))} placeholder="By kind, then Other" options={opts(lookups.data?.ciTypes)} />
          </FormField>
          <FormField label="Stale after (days)">
            <Input disabled={!manage} type="number" min={1} max={365} value={f.staleDays} onChange={(e) => set('staleDays', Number(e.target.value))} />
          </FormField>
        </FormGrid>
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">CI type per atlas kind</div>
          <FormGrid cols={3}>
            {KINDS.map((k) => (
              <FormField key={k} label={k}>
                <Select
                  disabled={!manage}
                  value={f.ciTypeMap[k] ?? ''}
                  onChange={(e) => {
                    const m = { ...f.ciTypeMap };
                    if (e.target.value) m[k] = Number(e.target.value);
                    else delete m[k];
                    set('ciTypeMap', m);
                  }}
                  placeholder="Automatic"
                  options={opts(lookups.data?.ciTypes)}
                />
              </FormField>
            ))}
          </FormGrid>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Checkbox disabled={!manage} label="Accept incidents and inventory from atlas" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <Checkbox disabled={!manage} label="Create a ticket for each new incident" checked={f.autoCreateTickets} onChange={(e) => set('autoCreateTickets', e.target.checked)} />
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save settings
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Tokens({ view, manage }: { view: View; manage: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('atlas');
  const [scopes, setScopes] = useState<IntegrationScope[]>(['atlas.incidents', 'atlas.cmdb']);
  const [shown, setShown] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>('/integrations/tokens', { name, scopes }),
    onSuccess: (r) => {
      setShown(r.token);
      qc.invalidateQueries({ queryKey: ['atlas'] });
    },
    onError: (e) => handleFormError(e),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.delete(`/integrations/tokens/${id}`),
    onSuccess: () => {
      toast.success('Token revoked');
      qc.invalidateQueries({ queryKey: ['atlas'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not revoke'),
  });
  const cols: Column<Token>[] = [
    { header: 'Name', cell: ({ row }) => <div><div className="font-medium">{row.original.name}</div><div className="font-mono text-[11px] text-muted">{row.original.prefix}…</div></div> },
    { header: 'Scopes', cell: ({ row }) => <div className="flex flex-wrap gap-1">{row.original.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div> },
    { header: 'Created', cell: ({ row }) => <span className="text-xs text-muted">{fmtDateTime(row.original.createdAt)}</span> },
    { header: 'Last used', cell: ({ row }) => <span className="text-xs text-muted">{row.original.lastUsedAt ? fmtRelative(row.original.lastUsedAt) : 'never'}</span> },
    { header: 'State', cell: ({ row }) => (row.original.revokedAt ? <Badge tone="danger">revoked</Badge> : row.original.expiresAt && new Date(row.original.expiresAt) < new Date() ? <Badge tone="warning">expired</Badge> : <Badge tone="success">active</Badge>) },
    {
      header: '',
      id: 'actions',
      cell: ({ row }) =>
        manage && !row.original.revokedAt ? (
          <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => revoke.mutate(row.original.id)}>
            Revoke
          </Button>
        ) : null,
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Integration tokens"
        description="atlas authenticates with one of these. Tokens are not users: no session, no UI access, only their scopes."
        actions={
          manage && (
            <Button size="sm" onClick={() => { setShown(null); setOpen(true); }}>
              <KeyRound /> New token
            </Button>
          )
        }
      />
      <DataTable columns={cols} data={view.tokens} />
      <Dialog open={open} onOpenChange={setOpen} title="New integration token">
        {shown ? (
          <div className="space-y-3">
            <p className="text-xs text-warning">Copy it now: it is stored hashed and will never be shown again. Paste it into atlas → Integrations → Taskora.</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={shown} className="font-mono text-[12px]" onFocus={(e) => e.target.select()} />
              <Button size="sm" onClick={() => navigator.clipboard.writeText(shown).then(() => toast.success('Copied'))}>
                <Copy />
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <FormField label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </FormField>
            {INTEGRATION_SCOPE_KEYS.map((s) => (
              <Checkbox key={s} label={`${s} — ${view.scopes[s]}`} checked={scopes.includes(s)} onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))} />
            ))}
            <Button variant="primary" loading={create.isPending} disabled={!scopes.length || !name.trim()} onClick={() => create.mutate()}>
              Create token
            </Button>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

function Incidents() {
  const [openOnly, setOpenOnly] = useState(true);
  const q = useQuery({ queryKey: ['atlas-incidents', openOnly], queryFn: () => api.get<{ data: IncidentRow[] }>('/integrations/atlas/incidents', { open: openOnly ? 'true' : undefined }) });
  const cols: Column<IncidentRow>[] = [
    {
      header: 'Incident',
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.title}</div>
          <div className="font-mono text-[11px] text-muted">{row.original.externalKey} · rev {row.original.revision}</div>
        </div>
      ),
    },
    { header: 'Severity', cell: ({ row }) => <Badge tone={severityTone(row.original.severity)}>{row.original.severity}</Badge> },
    {
      header: 'atlas state',
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={row.original.state === 'resolved' ? 'success' : 'danger'}>{row.original.state}</Badge>
          {row.original.persisting && <Badge tone="danger">still failing</Badge>}
        </span>
      ),
    },
    {
      header: 'Ticket',
      cell: ({ row }) =>
        row.original.ticket ? (
          <Link to={`/tickets/${row.original.ticket.id}`} className="hover:text-primary">
            {row.original.ticket.number} <span className="text-xs text-muted">{row.original.ticket.status}{row.original.ticket.assignee ? ` · ${row.original.ticket.assignee}` : ''}</span>
          </Link>
        ) : (
          <span className="text-subtle">none</span>
        ),
    },
    { header: 'Last observed', cell: ({ row }) => <span className="text-xs text-muted">{fmtRelative(row.original.lastObservedAt)}</span> },
    {
      header: '',
      id: 'actions',
      cell: ({ row }) =>
        safeHref(row.original.link) ? (
          <a href={safeHref(row.original.link)!} target="_blank" rel="noreferrer noopener" className="text-xs text-primary hover:underline">
            atlas
          </a>
        ) : null,
    },
  ];
  return (
    <Card>
      <CardHeader title="Incidents from atlas" actions={<Checkbox label="Open only" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />} />
      <DataTable columns={cols} data={q.data?.data} loading={q.isLoading} />
    </Card>
  );
}

function Entities({ manage, companyId }: { manage: boolean; companyId: number | null }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [linking, setLinking] = useState<EntityRow | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['atlas-entities', status, search, page],
    queryFn: () => api.get<{ data: EntityRow[]; total: number; counts: Record<string, number> }>('/integrations/atlas/entities', { status: status || undefined, q: search || undefined, page, pageSize: 50 }),
  });
  const resolve = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.post(`/integrations/atlas/entities/${id}/resolve`, body),
    onSuccess: () => {
      toast.success('Saved');
      setLinking(null);
      qc.invalidateQueries({ queryKey: ['atlas-entities'] });
      qc.invalidateQueries({ queryKey: ['atlas-entity-counts'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save'),
  });
  const act = (row: EntityRow, action: string) => resolve.mutate({ id: row.id, body: { action } });
  const cols: Column<EntityRow>[] = [
    {
      header: 'Observed by atlas',
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          <div className="text-[11px] text-muted">{[row.original.kind, row.original.ipAddresses[0], row.original.macAddresses[0]].filter(Boolean).join(' · ')}</div>
        </div>
      ),
    },
    {
      header: 'Match',
      cell: ({ row }) => (
        <div>
          <Badge tone={matchTone(row.original.matchStatus)}>{row.original.matchStatus}</Badge>
          {row.original.matchNote && <div className="mt-0.5 max-w-xs text-[11px] text-muted">{row.original.matchNote}</div>}
        </div>
      ),
    },
    {
      header: 'Configuration item',
      cell: ({ row }) =>
        row.original.configurationItemId ? (
          <Link to={`/assets/${row.original.configurationItemId}`} className="hover:text-primary">
            {row.original.ciName} <span className="text-[11px] text-muted">{row.original.ciNumber}</span>
          </Link>
        ) : (
          <span className="text-subtle">—</span>
        ),
    },
    { header: 'Owner', cell: ({ row }) => <Badge>{row.original.provenance}</Badge> },
    { header: 'Freshness', cell: ({ row }) => <Badge tone={freshnessTone(row.original.freshness)}>{row.original.freshness}</Badge> },
    {
      header: '',
      id: 'actions',
      cell: ({ row }) =>
        manage ? (
          <div className="flex flex-wrap justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => { setTarget(row.original.configurationItemId); setLinking(row.original); }}>
              Link…
            </Button>
            {!row.original.configurationItemId && (
              <Button size="sm" variant="ghost" onClick={() => act(row.original, 'create')}>
                Create CI
              </Button>
            )}
            {row.original.configurationItemId && (
              <Button size="sm" variant="ghost" onClick={() => act(row.original, 'unlink')}>
                Unlink
              </Button>
            )}
            {row.original.matchStatus !== 'ignored' && (
              <Button size="sm" variant="ghost" onClick={() => act(row.original, 'ignore')}>
                Ignore
              </Button>
            )}
            {row.original.freshness === 'missing' && (
              <Button size="sm" variant="ghost" onClick={() => act(row.original, 'decommission')}>
                Decommissioned
              </Button>
            )}
          </div>
        ) : null,
    },
  ];
  const counts = q.data?.counts ?? {};
  return (
    <Card>
      <CardHeader
        title="Observed infrastructure"
        description="Strong identifiers (MAC, serial) link automatically; a name alone is only a proposal; ambiguity is a conflict for you to decide. Nothing is ever deleted."
        actions={
          <div className="flex gap-2">
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search" className="w-40" />
            <Select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              placeholder="All"
              options={['conflict', 'proposed', 'unmatched', 'linked', 'created', 'ignored'].map((s) => ({ value: s, label: `${s} (${counts[s] ?? 0})` }))}
            />
          </div>
        }
      />
      <DataTable columns={cols} data={q.data?.data} total={q.data?.total} page={page} pageSize={50} onPageChange={setPage} loading={q.isLoading} />
      <Dialog open={linking !== null} onOpenChange={(o) => !o && setLinking(null)} title={`Link ${linking?.name ?? ''}`}>
        <div className="space-y-3">
          <p className="text-xs text-muted">The CI keeps its own fields; atlas only attaches its observations to it. A CI can carry one atlas entity.</p>
          <EntityPicker kind="ci" value={target} onChange={setTarget} filter={companyId ? { companyId } : undefined} placeholder="Choose a configuration item" />
          <Button variant="primary" disabled={!target} loading={resolve.isPending} onClick={() => linking && target && resolve.mutate({ id: linking.id, body: { action: 'link', configurationItemId: target } })}>
            Link
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}

interface Run {
  id: number;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, number>;
  error: string | null;
}

function Runs() {
  const q = useQuery({ queryKey: ['atlas-runs'], queryFn: () => api.get<{ data: Run[] }>('/integrations/atlas/runs') });
  const cols: Column<Run>[] = [
    { header: 'Started', cell: ({ row }) => fmtDateTime(row.original.startedAt) },
    { header: 'By', cell: ({ row }) => <Badge>{row.original.trigger.replace(/^atlas:/, '')}</Badge> },
    { header: 'Status', cell: ({ row }) => <Badge tone={row.original.status === 'success' ? 'success' : row.original.status === 'failed' ? 'danger' : 'info'}>{row.original.status}</Badge> },
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
      <CardHeader title="Inventory syncs" description="Applied syncs only; atlas previews write nothing here." />
      <DataTable columns={cols} data={q.data?.data} loading={q.isLoading} />
    </Card>
  );
}

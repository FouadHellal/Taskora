import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, HardDrive, Pencil, Plus, Ticket, Trash2, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { CI_LIFECYCLE, CI_RELATION_TYPE, formatMinutes } from '@taskora/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, PageLoader } from '@/components/ui/misc';
import { ConfirmDialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { Input, Select } from '@/components/ui/input';
import { LifecycleBadge } from '@/components/badges';
import { Action1Panel } from '@/components/action1-panel';
import { AtlasCiPanel } from '@/components/atlas-panel';
import { CiFormDialog, type CiRecord } from '@/components/forms/ci-form';
import { CustomFieldsView } from '@/components/custom-fields';
import { RelatedTickets } from '@/components/related-tables';
import { EntityPicker } from '@/components/entity-picker';
import { Attachments } from '@/pages/tickets/detail';
import { handleFormError } from '@/components/form';

interface CiDetail extends CiRecord {
  ciNumber: string;
  ciTypeName: string;
  ciCategory: string;
  companyName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactTitle: string | null;
  locationName: string | null;
  productName: string | null;
  source: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: { openTickets: number; totalTickets: number; minutes: number };
}

export default function CiDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const q = useQuery({ queryKey: ['ci', id], queryFn: () => api.get<CiDetail>(`/configuration-items/${id}`) });
  const remove = useMutation({
    mutationFn: () => api.delete(`/configuration-items/${id}`),
    onSuccess: () => {
      toast.success('Configuration item deleted');
      qc.invalidateQueries({ queryKey: ['cis'] });
      navigate('/assets');
    },
    onError: (e) => handleFormError(e),
  });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <EmptyState title="Configuration item not found" />;
  const ci = q.data;
  const warrantyExpired = ci.warrantyExpiresAt && new Date(ci.warrantyExpiresAt) < new Date();

  return (
    <div>
      <PageHeader
        title={ci.name}
        icon={<HardDrive />}
        breadcrumbs={[{ label: 'Configuration Items', to: '/assets' }, { label: ci.companyName, to: `/companies/${ci.companyId}` }, { label: ci.ciNumber }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{ci.ciNumber}</span>
            <Badge>{ci.ciTypeName}</Badge>
            <LifecycleBadge status={ci.lifecycleStatus} label={CI_LIFECYCLE.labels[ci.lifecycleStatus as keyof typeof CI_LIFECYCLE.labels]} />
            {ci.source !== 'manual' && <Badge tone="info">Synced from {ci.source === 'action1' ? 'Action1' : ci.source}</Badge>}
            {warrantyExpired && <Badge tone="danger">Warranty expired</Badge>}
          </span>
        }
        actions={
          <>
            {can('tickets.write') && (
              <Button variant="primary" onClick={() => navigate(`/tickets/new?companyId=${ci.companyId}&ciId=${id}${ci.contactId ? `&contactId=${ci.contactId}` : ''}`)}>
                <Ticket /> New ticket
              </Button>
            )}
            {can('cis.write') && (
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can('cis.delete') && (
              <Button variant="ghost" onClick={() => setDeleting(true)} aria-label="Delete CI">
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 p-5 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Hardware" />
              <CardBody>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <Field label="Manufacturer">{ci.manufacturer}</Field>
                  <Field label="Model">{ci.model}</Field>
                  <Field label="Serial number">{ci.serialNumber && <CopyText text={ci.serialNumber} />}</Field>
                  <Field label="Asset tag">{ci.assetTag}</Field>
                  <Field label="CPU">{ci.cpu}</Field>
                  <Field label="RAM / storage">{[ci.ramGb && `${ci.ramGb} GB RAM`, ci.storageGb && `${ci.storageGb} GB`].filter(Boolean).join(' · ') || null}</Field>
                  <Field label="Product">{ci.productName}</Field>
                </dl>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Operating system & network" />
              <CardBody>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <Field label="Hostname">{ci.hostname && <CopyText text={ci.hostname} />}</Field>
                  <Field label="Operating system">{[ci.osName, ci.osVersion].filter(Boolean).join(' ') || null}</Field>
                  <Field label="IP address">{ci.ipAddress && <CopyText text={ci.ipAddress} />}</Field>
                  <Field label="MAC address">{ci.macAddress}</Field>
                  <Field label="Last seen">{ci.lastSeenAt ? <span title={fmtDateTime(ci.lastSeenAt)}>{fmtRelative(ci.lastSeenAt)}</span> : null}</Field>
                  <Field label="Source">{ci.source}</Field>
                </dl>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Action1 endpoint" description="Live device state synchronised from Action1 (read-only)" />
            <CardBody>
              <Action1Panel ciId={id} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="atlas observations" description="What atlas sees on the network and hypervisors (atlas-owned, read-only)" />
            <CardBody>
              <AtlasCiPanel ciId={id} />
            </CardBody>
          </Card>

          <Card>
            <Tabs defaultValue="tickets">
              <div className="px-2">
                <TabsList className="border-b-0">
                  <TabsTrigger value="tickets" count={ci.stats.totalTickets}>
                    Tickets
                  </TabsTrigger>
                  <TabsTrigger value="relations">Relationships</TabsTrigger>
                  <TabsTrigger value="software">Software</TabsTrigger>
                  <TabsTrigger value="activity">Activity & audit</TabsTrigger>
                  <TabsTrigger value="files">Attachments</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="tickets" className="border-t border-border">
                <RelatedTickets filter={{ configurationItemId: id }} scope="all" />
              </TabsContent>
              <TabsContent value="relations" className="border-t border-border p-4">
                <Relations ciId={id} companyId={ci.companyId} canWrite={can('cis.write')} />
              </TabsContent>
              <TabsContent value="software" className="border-t border-border p-4">
                <SoftwareList ciId={id} canWrite={can('cis.write')} />
              </TabsContent>
              <TabsContent value="activity" className="border-t border-border p-4">
                <CiActivity ciId={id} />
              </TabsContent>
              <TabsContent value="files" className="border-t border-border p-4">
                <Attachments entityType="configuration_item" entityId={id} canWrite={can('cis.write')} />
              </TabsContent>
            </Tabs>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader title="Ownership" />
            <CardBody className="space-y-2.5 text-[13px]">
              <Link to={`/companies/${ci.companyId}`} className="flex items-center gap-2 font-medium hover:text-primary">
                <Building2 className="size-3.5 text-muted" /> {ci.companyName}
              </Link>
              {ci.contactId ? (
                <div>
                  <Link to={`/contacts/${ci.contactId}`} className="flex items-center gap-2 font-medium hover:text-primary">
                    <UserRound className="size-3.5 text-muted" /> {ci.contactName}
                  </Link>
                  <div className="ml-5.5 text-xs text-muted">{[ci.contactTitle, ci.contactEmail, ci.contactPhone].filter(Boolean).join(' · ')}</div>
                </div>
              ) : (
                <p className="text-xs text-muted">Not assigned to a contact.</p>
              )}
              {ci.locationName && <div className="text-xs text-muted">Location: {ci.locationName}</div>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Lifecycle & warranty" />
            <CardBody>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <Field label="Purchased">{fmtDate(ci.purchaseDate, '') || null}</Field>
                <Field label="Cost">{ci.purchaseCost ?? null}</Field>
                <Field label="Installed">{fmtDate(ci.installDate, '') || null}</Field>
                <Field label="Warranty until">
                  {ci.warrantyExpiresAt ? <span className={warrantyExpired ? 'text-danger' : ''}>{fmtDate(ci.warrantyExpiresAt)}</span> : null}
                </Field>
                <Field label="Support until">{fmtDate(ci.supportExpiresAt, '') || null}</Field>
                <Field label="Created">{fmtDate(ci.createdAt)}</Field>
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Service history" />
            <CardBody>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <Field label="Open tickets">{ci.stats.openTickets}</Field>
                <Field label="All tickets">{ci.stats.totalTickets}</Field>
                <Field label="Time spent">{formatMinutes(ci.stats.minutes)}</Field>
              </dl>
            </CardBody>
          </Card>
          {(Object.keys(ci.customFields ?? {}).length > 0 || ci.notes) && (
            <Card>
              <CardHeader title="Notes & custom fields" />
              <CardBody className="space-y-3">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  <CustomFieldsView entity="configuration_item" value={ci.customFields} />
                </dl>
                {ci.notes && <p className="prose-note text-[13px]">{ci.notes}</p>}
              </CardBody>
            </Card>
          )}
        </aside>
      </div>
      <CiFormDialog open={editing} onOpenChange={setEditing} ci={ci} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${ci.name}?`}
        description="The CI is removed and unlinked from its tickets. Prefer setting the lifecycle to Retired or Disposed to keep history."
        danger
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function CopyText({ text }: { text: string }) {
  return (
    <span className="group inline-flex items-center gap-1">
      <span className="font-mono text-[12px]">{text}</span>
      <button
        className="cursor-pointer text-subtle opacity-0 group-hover:opacity-100"
        onClick={() => {
          navigator.clipboard?.writeText(text);
          toast.success('Copied');
        }}
        aria-label="Copy"
      >
        <Copy className="size-3" />
      </button>
    </span>
  );
}

interface Relation {
  id: number;
  type: string;
  direction: 'incoming' | 'outgoing';
  ciId: number;
  ciNumber: string;
  name: string;
  ciTypeName: string;
  lifecycleStatus: string;
}

function Relations({ ciId, companyId, canWrite }: { ciId: number; companyId: number; canWrite: boolean }) {
  const qc = useQueryClient();
  const rel = useQuery({ queryKey: ['ci-relations', ciId], queryFn: () => api.get<{ data: Relation[] }>(`/configuration-items/${ciId}/relations`) });
  const [target, setTarget] = useState<number | null>(null);
  const [type, setType] = useState('connected_to');
  const add = useMutation({
    mutationFn: () => api.post(`/configuration-items/${ciId}/relations`, { relatedCiId: target, type }),
    onSuccess: () => {
      setTarget(null);
      qc.invalidateQueries({ queryKey: ['ci-relations', ciId] });
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: (rid: number) => api.delete(`/configuration-items/${ciId}/relations/${rid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ci-relations', ciId] }),
  });
  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44">
            <Select value={type} onChange={(e) => setType(e.target.value)} options={CI_RELATION_TYPE.values.map((v) => ({ value: v, label: CI_RELATION_TYPE.labels[v] }))} />
          </div>
          <div className="min-w-64 flex-1">
            <EntityPicker kind="ci" value={target} onChange={setTarget} filter={{ companyId }} placeholder="Select a related CI…" />
          </div>
          <Button variant="primary" disabled={!target} loading={add.isPending} onClick={() => add.mutate()}>
            <Plus /> Add
          </Button>
        </div>
      )}
      {(rel.data?.data ?? []).length === 0 ? (
        <p className="text-xs text-muted">No relationships. Link servers to the VMs they host, switches to firewalls, licences to devices…</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rel.data!.data.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <Badge>
                {r.direction === 'outgoing' ? '' : '← '}
                {CI_RELATION_TYPE.labels[r.type as keyof typeof CI_RELATION_TYPE.labels] ?? r.type}
              </Badge>
              <Link to={`/assets/${r.ciId}`} className="flex-1 hover:text-primary">
                {r.name} <span className="text-xs text-muted">{r.ciTypeName}</span>
              </Link>
              <LifecycleBadge status={r.lifecycleStatus} />
              {canWrite && (
                <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(r.id)} aria-label="Remove relationship">
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SoftwareList({ ciId, canWrite }: { ciId: number; canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['ci-software', ciId],
    queryFn: () => api.get<{ data: { id: number; name: string; version: string | null; publisher: string | null; installedAt: string | null; source: string }[] }>(`/configuration-items/${ciId}/software`),
  });
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const add = useMutation({
    mutationFn: () => api.post(`/configuration-items/${ciId}/software`, { name, version }),
    onSuccess: () => {
      setName('');
      setVersion('');
      qc.invalidateQueries({ queryKey: ['ci-software', ciId] });
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: (sid: number) => api.delete(`/configuration-items/${ciId}/software/${sid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ci-software', ciId] }),
  });
  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Software name" />
          <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Version" className="w-32" />
          <Button disabled={!name.trim()} onClick={() => add.mutate()} loading={add.isPending}>
            <Plus /> Add
          </Button>
        </div>
      )}
      {(q.data?.data ?? []).length === 0 ? (
        <p className="text-xs text-muted">No software recorded.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="py-1.5">Name</th>
                <th>Version</th>
                <th>Publisher</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data!.data.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="py-1.5">{s.name}</td>
                  <td className="text-muted">{s.version ?? '—'}</td>
                  <td className="text-muted">{s.publisher ?? '—'}</td>
                  <td className="text-muted">{s.source}</td>
                  <td className="text-right">
                    {canWrite && (
                      <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(s.id)} aria-label="Remove software">
                        <X />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CiActivity({ ciId }: { ciId: number }) {
  const q = useQuery({
    queryKey: ['ci-activity', ciId],
    queryFn: () => api.get<{ data: { kind: string; id: number; subtype: string; title: string; at: string; actor: string | null }[] }>(`/configuration-items/${ciId}/activity`),
  });
  if (!q.data?.data.length) return <p className="text-xs text-muted">No activity recorded.</p>;
  return (
    <ul className="space-y-2">
      {q.data.data.map((a) => (
        <li key={`${a.kind}-${a.id}`} className="flex items-center gap-2 text-[13px]">
          <Badge tone={a.kind === 'ticket' ? 'primary' : 'neutral'}>{a.kind === 'ticket' ? 'Ticket' : a.subtype}</Badge>
          {a.kind === 'ticket' ? (
            <Link to={`/tickets/${a.id}`} className="flex-1 truncate hover:text-primary">
              {a.title}
            </Link>
          ) : (
            <span className="flex-1 truncate">{a.title}</span>
          )}
          <span className="text-xs text-muted">{a.actor ?? 'System'}</span>
          <span className="w-24 text-right text-xs text-subtle" title={fmtDateTime(a.at)}>
            {fmtRelative(a.at)}
          </span>
        </li>
      ))}
    </ul>
  );
}

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Settings2, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { CI_CATEGORY } from '@taskora/shared';
import { api } from '@/lib/api';
import { opts, useLookups } from '@/lib/lookups';
import { fmtDate } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, PageLoader } from '@/components/ui/misc';
import { Dialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { FormField, FormGrid, FormSection, handleFormError } from '@/components/form';
import { SettingsTable } from '@/components/admin/settings-table';
import { timezoneOptions } from '@/components/admin/timezones';
import { useTabParam } from '@/components/admin/tabs';
import { LogoEditor } from '@/components/logo';
import { SystemHealth } from '@/components/admin/system-health';
import { EntityPicker } from '@/components/entity-picker';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = { id: number } & Record<string, any>;

export default function SystemSettingsPage() {
  const [tab, setTab] = useTabParam('general');
  const lookups = useLookups();
  const L = lookups.data;
  const inv = [['lookups']];
  return (
    <div>
      <PageHeader title="System Settings" icon={<Settings2 />} subtitle="Organization, SLAs, calendars, billing configuration and notification templates" />
      <div className="p-5">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="sla">SLA policies</TabsTrigger>
            <TabsTrigger value="hours">Business hours</TabsTrigger>
            <TabsTrigger value="work-types">Work types</TabsTrigger>
            <TabsTrigger value="billing-codes">Billing codes</TabsTrigger>
            <TabsTrigger value="ci-types">CI types</TabsTrigger>
            <TabsTrigger value="templates">Notification templates</TabsTrigger>
            <TabsTrigger value="health">Health</TabsTrigger>
          </TabsList>
          <TabsContent value="health" className="mt-4">
            <SystemHealth />
          </TabsContent>
          <TabsContent value="general" className="mt-4">
            <GeneralSettings />
          </TabsContent>
          <TabsContent value="sla" className="mt-4">
            <SlaPolicies />
          </TabsContent>
          <TabsContent value="hours" className="mt-4">
            <BusinessHours />
          </TabsContent>
          <TabsContent value="work-types" className="mt-4">
            <SettingsTable<AnyRow>
              title="Work types"
              description="Classify labour on time entries; default rates and billability"
              entityLabel="work type"
              endpoint="/settings/work-types"
              canWrite
              invalidate={inv}
              defaults={{ name: '', code: '', billingCodeId: '', hourlyRate: '', isBillable: true, isActive: true, sortOrder: 0, description: '' }}
              columns={[
                { header: 'Name', cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
                { header: 'Code', cell: ({ row }) => row.original.code ?? '—' },
                { header: 'Rate', meta: { align: 'right' }, cell: ({ row }) => row.original.hourlyRate ?? '—' },
                { header: 'Billable', cell: ({ row }) => (row.original.isBillable ? <Badge tone="success">Billable</Badge> : <Badge>Non-billable</Badge>) },
                { header: 'Active', cell: ({ row }) => (row.original.isActive ? 'Yes' : 'No') },
              ]}
              fields={[
                { name: 'name', label: 'Name', type: 'text', required: true },
                { name: 'code', label: 'Code', type: 'text' },
                { name: 'billingCodeId', label: 'Billing code', type: 'select', numeric: true, options: opts(L?.billingCodes) },
                { name: 'hourlyRate', label: 'Default hourly rate', type: 'number', step: 0.01 },
                { name: 'isBillable', label: 'Billable by default', type: 'checkbox' },
                { name: 'isActive', label: 'Active', type: 'checkbox' },
                { name: 'sortOrder', label: 'Sort order', type: 'number' },
              ]}
            />
          </TabsContent>
          <TabsContent value="billing-codes" className="mt-4">
            <SettingsTable<AnyRow>
              title="Billing codes"
              entityLabel="billing code"
              endpoint="/settings/billing-codes"
              canWrite
              invalidate={inv}
              defaults={{ code: '', name: '', kind: 'labor', isActive: true, sortOrder: 0, description: '' }}
              columns={[
                { header: 'Code', cell: ({ row }) => <span className="font-mono">{row.original.code}</span> },
                { header: 'Name', cell: ({ row }) => row.original.name },
                { header: 'Kind', cell: ({ row }) => <Badge>{row.original.kind}</Badge> },
                { header: 'Active', cell: ({ row }) => (row.original.isActive ? 'Yes' : 'No') },
              ]}
              fields={[
                { name: 'code', label: 'Code', type: 'text', required: true, mono: true },
                { name: 'name', label: 'Name', type: 'text', required: true },
                {
                  name: 'kind',
                  label: 'Kind',
                  type: 'select',
                  options: ['labor', 'expense', 'material', 'service'].map((v) => ({ value: v, label: v })),
                },
                { name: 'isActive', label: 'Active', type: 'checkbox' },
                { name: 'sortOrder', label: 'Sort order', type: 'number' },
              ]}
            />
          </TabsContent>
          <TabsContent value="ci-types" className="mt-4">
            <SettingsTable<AnyRow>
              title="Configuration item types"
              entityLabel="CI type"
              endpoint="/settings/ci-types"
              canWrite
              invalidate={inv}
              defaults={{ name: '', category: 'other', isActive: true, sortOrder: 0, description: '' }}
              columns={[
                { header: 'Name', cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
                { header: 'Category', cell: ({ row }) => CI_CATEGORY.labels[row.original.category as keyof typeof CI_CATEGORY.labels] },
                { header: 'Active', cell: ({ row }) => (row.original.isActive ? 'Yes' : 'No') },
              ]}
              fields={[
                { name: 'name', label: 'Name', type: 'text', required: true },
                { name: 'category', label: 'Category', type: 'select', options: CI_CATEGORY.values.map((v) => ({ value: v, label: CI_CATEGORY.labels[v] })) },
                { name: 'isActive', label: 'Active', type: 'checkbox' },
                { name: 'sortOrder', label: 'Sort order', type: 'number' },
              ]}
            />
          </TabsContent>
          <TabsContent value="templates" className="mt-4">
            <SettingsTable<AnyRow>
              title="Notification templates"
              description="Placeholders: {{ticket.number}}, {{ticket.title}}, {{ticket.company}}, {{actor.name}}, {{sla.event}}, {{sla.due}}"
              entityLabel="template"
              endpoint="/settings/notification-templates"
              canWrite
              dialogSize="lg"
              defaults={{ event: '', name: '', subject: '', body: '', isActive: true }}
              columns={[
                { header: 'Event', cell: ({ row }) => <span className="font-mono text-[12px]">{row.original.event}</span> },
                { header: 'Name', cell: ({ row }) => row.original.name },
                { header: 'Subject', cell: ({ row }) => <span className="text-muted">{row.original.subject}</span> },
                { header: 'Active', cell: ({ row }) => (row.original.isActive ? 'Yes' : 'No') },
              ]}
              fields={[
                { name: 'event', label: 'Event key', type: 'text', required: true, mono: true, readOnlyOnEdit: true },
                { name: 'name', label: 'Name', type: 'text', required: true },
                { name: 'subject', label: 'Subject', type: 'text', required: true, span: 2 },
                { name: 'body', label: 'Body', type: 'textarea', required: true, span: 2, rows: 5 },
                { name: 'isActive', label: 'Active', type: 'checkbox' },
              ]}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

type SystemSettings = Record<string, string | number | boolean | null>;

function GeneralSettings() {
  const qc = useQueryClient();
  const lookups = useLookups();
  const q = useQuery({ queryKey: ['system-settings'], queryFn: () => api.get<SystemSettings>('/settings/system') });
  const [f, setF] = useState<SystemSettings>({});
  useEffect(() => q.data && setF(q.data), [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put('/settings/system', {
        ...f,
        defaultWorkTypeId: f.defaultWorkTypeId ? Number(f.defaultWorkTypeId) : null,
        inboundEmailCompanyId: f.inboundEmailCompanyId ? Number(f.inboundEmailCompanyId) : null,
        inboundEmailQueueId: f.inboundEmailQueueId ? Number(f.inboundEmailQueueId) : null,
      }),
    onSuccess: () => {
      toast.success('Settings saved');
      qc.invalidateQueries({ queryKey: ['system-settings'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => handleFormError(e),
  });
  if (!q.data) return <PageLoader />;
  const text = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <FormField label={label}>
      <Input value={String(f[k] ?? '')} onChange={(e) => setF({ ...f, [k]: props.type === 'number' ? Number(e.target.value) : e.target.value })} {...props} />
    </FormField>
  );
  return (
    <Card>
      <CardBody className="space-y-6">
        <FormSection title="Organization">
          <FormGrid cols={3}>
            {text('organizationName', 'Organization name')}
            <FormField label="Time zone">
              <Select value={String(f.timezone ?? 'UTC')} onChange={(e) => setF({ ...f, timezone: e.target.value })} options={timezoneOptions(String(f.timezone ?? ''))} />
            </FormField>
            {text('currency', 'Currency (ISO code)', { maxLength: 3 })}
          </FormGrid>
          <FormField label="Logo" hint="Shown in the sidebar and on the sign-in pages">
            <LogoEditor
              kind="organization"
              logoUpdatedAt={q.data.logoUpdatedAt ? String(q.data.logoUpdatedAt) : null}
              onChanged={() => {
                qc.invalidateQueries({ queryKey: ['system-settings'] });
                qc.invalidateQueries({ queryKey: ['me'] });
              }}
            />
          </FormField>
          <FormField label="Company address (invoices)">
            <Textarea rows={3} value={String(f.companyAddress ?? '')} onChange={(e) => setF({ ...f, companyAddress: e.target.value })} />
          </FormField>
        </FormSection>
        <FormSection title="Numbering prefixes">
          <FormGrid cols={4}>
            {text('ticketPrefix', 'Tickets')}
            {text('ciPrefix', 'Configuration items')}
            {text('contractPrefix', 'Contracts')}
            {text('projectPrefix', 'Projects')}
            {text('invoicePrefix', 'Invoices')}
            {text('kbPrefix', 'Knowledge articles')}
          </FormGrid>
        </FormSection>
        <FormSection title="Service desk, time & billing">
          <FormGrid cols={3}>
            {text('slaWarningMinutes', 'SLA "at risk" warning (minutes before due)', { type: 'number', min: 5 })}
            {text('timeRoundingMinutes', 'Round time entries up to (minutes)', { type: 'number', min: 1, max: 60 })}
            <FormField label="Default work type">
              <Select value={String(f.defaultWorkTypeId ?? '')} onChange={(e) => setF({ ...f, defaultWorkTypeId: e.target.value || null })} placeholder="—" options={opts(lookups.data?.workTypes)} />
            </FormField>
            {text('invoicePaymentTermsDays', 'Invoice payment terms (days)', { type: 'number', min: 0 })}
          </FormGrid>
          <Checkbox label="Time entries require approval before billing" checked={!!f.requireTimeApproval} onChange={(e) => setF({ ...f, requireTimeApproval: e.target.checked })} />
          <FormField label="Invoice footer">
            <Textarea rows={2} value={String(f.invoiceFooter ?? '')} onChange={(e) => setF({ ...f, invoiceFooter: e.target.value })} />
          </FormField>
        </FormSection>
        <FormSection title="Inbound e-mail">
          <FormGrid cols={2}>
            <FormField label="Company for unknown senders" hint="Leave empty to reject e-mail from senders who are not a contact or a known company domain">
              <EntityPicker kind="company" value={f.inboundEmailCompanyId ? Number(f.inboundEmailCompanyId) : null} onChange={(id) => setF({ ...f, inboundEmailCompanyId: id })} placeholder="Reject unknown senders" />
            </FormField>
            <FormField label="Queue for e-mail tickets">
              <Select value={String(f.inboundEmailQueueId ?? '')} onChange={(e) => setF({ ...f, inboundEmailQueueId: e.target.value || null })} placeholder="—" options={opts(lookups.data?.queues)} />
            </FormField>
          </FormGrid>
        </FormSection>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save settings
        </Button>
      </CardBody>
    </Card>
  );
}

interface SlaPolicy {
  id: number;
  name: string;
  description: string | null;
  businessHoursId: number | null;
  isDefault: boolean;
  isActive: boolean;
  targets: { priorityId: number; firstResponseMinutes: number | null; resolutionMinutes: number | null }[];
}

const toH = (m: number | null) => (m == null ? '' : String(Math.round((m / 60) * 100) / 100));
const toM = (h: string) => (h === '' ? null : Math.max(1, Math.round(Number(h) * 60)));

function SlaPolicies() {
  const q = useQuery({ queryKey: ['sla-policies'], queryFn: () => api.get<{ data: SlaPolicy[] }>('/settings/sla-policies') });
  const hours = useQuery({ queryKey: ['business-hours'], queryFn: () => api.get<{ data: { id: number; name: string }[] }>('/settings/business-hours') });
  const lookups = useLookups();
  const [editing, setEditing] = useState<SlaPolicy | 'new' | null>(null);
  return (
    <Card>
      <CardHeader
        title="SLA policies"
        description="Response and resolution targets per priority, measured in business time"
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            <Plus /> New policy
          </Button>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="px-4 py-2">Policy</th>
              <th className="px-4 py-2">Calendar</th>
              {lookups.data?.priorities.map((p) => (
                <th key={p.id} className="px-4 py-2">
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {q.data?.data.map((p) => (
              <tr key={p.id} className="cursor-pointer border-t border-border hover:bg-surface-2" onClick={() => setEditing(p)}>
                <td className="px-4 py-2">
                  <span className="font-medium">{p.name}</span> {p.isDefault && <Badge tone="primary">Default</Badge>} {!p.isActive && <Badge>Inactive</Badge>}
                  {p.description && <div className="text-xs text-muted">{p.description}</div>}
                </td>
                <td className="px-4 py-2 text-muted">{hours.data?.data.find((h) => h.id === p.businessHoursId)?.name ?? '24x7'}</td>
                {lookups.data?.priorities.map((pr) => {
                  const t = p.targets.find((x) => x.priorityId === pr.id);
                  return (
                    <td key={pr.id} className="px-4 py-2 text-xs">
                      {t ? `${toH(t.firstResponseMinutes) || '—'} h / ${toH(t.resolutionMinutes) || '—'} h` : '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[11px] text-muted">Cells show first response / resolution targets in business hours.</p>
      {editing && <SlaDialog policy={editing === 'new' ? null : editing} calendars={hours.data?.data ?? []} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function SlaDialog({ policy, calendars, onClose }: { policy: SlaPolicy | null; calendars: { id: number; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const [f, setF] = useState({ name: policy?.name ?? '', description: policy?.description ?? '', businessHoursId: policy?.businessHoursId ?? null, isDefault: policy?.isDefault ?? false, isActive: policy?.isActive ?? true });
  const [targets, setTargets] = useState<Record<number, { fr: string; res: string }>>(() =>
    Object.fromEntries((lookups.data?.priorities ?? []).map((p) => {
      const t = policy?.targets.find((x) => x.priorityId === p.id);
      return [p.id, { fr: toH(t?.firstResponseMinutes ?? null), res: toH(t?.resolutionMinutes ?? null) }];
    })),
  );
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        targets: Object.entries(targets)
          .filter(([, v]) => v.fr || v.res)
          .map(([pid, v]) => ({ priorityId: Number(pid), firstResponseMinutes: toM(v.fr), resolutionMinutes: toM(v.res) })),
      };
      return policy ? api.put(`/settings/sla-policies/${policy.id}`, body) : api.post('/settings/sla-policies', body);
    },
    onSuccess: () => {
      toast.success('SLA policy saved');
      qc.invalidateQueries({ queryKey: ['sla-policies'] });
      qc.invalidateQueries({ queryKey: ['lookups'] });
      onClose();
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/settings/sla-policies/${policy!.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sla-policies'] });
      onClose();
    },
    onError: (e) => handleFormError(e),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={policy ? `Edit ${policy.name}` : 'New SLA policy'}
      size="lg"
      footer={
        <>
          {policy && (
            <Button variant="ghost" className="mr-auto text-danger" onClick={() => remove.mutate()} loading={remove.isPending}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!f.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormGrid cols={2}>
          <FormField label="Name" required>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </FormField>
          <FormField label="Business hours calendar" hint="Empty = 24x7">
            <Select value={f.businessHoursId ?? ''} onChange={(e) => setF({ ...f, businessHoursId: e.target.value ? Number(e.target.value) : null })} placeholder="24x7" options={calendars.map((c) => ({ value: c.id, label: c.name }))} />
          </FormField>
          <FormField label="Description" className="sm:col-span-2">
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </FormField>
        </FormGrid>
        <div className="flex gap-4">
          <Checkbox label="Default policy" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} />
          <Checkbox label="Active" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="py-1">Priority</th>
                <th>First response (h)</th>
                <th>Resolution (h)</th>
              </tr>
            </thead>
            <tbody>
              {lookups.data?.priorities.map((p) => (
                <tr key={p.id}>
                  <td className="py-1 pr-3 font-medium">{p.name}</td>
                  <td className="pr-3">
                    <Input type="number" min={0} step="0.25" value={targets[p.id]?.fr ?? ''} onChange={(e) => setTargets({ ...targets, [p.id]: { ...targets[p.id]!, fr: e.target.value } })} />
                  </td>
                  <td>
                    <Input type="number" min={0} step="0.25" value={targets[p.id]?.res ?? ''} onChange={(e) => setTargets({ ...targets, [p.id]: { ...targets[p.id]!, res: e.target.value } })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Dialog>
  );
}

const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
] as const;

interface Calendar {
  id: number;
  name: string;
  timezone: string;
  schedule: Record<string, [string, string][]>;
  isDefault: boolean;
}

function BusinessHours() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['business-hours'], queryFn: () => api.get<{ data: Calendar[] }>('/settings/business-hours') });
  const [selected, setSelected] = useState<number | null>(null);
  const cal = q.data?.data.find((c) => c.id === selected) ?? q.data?.data[0];
  const [draft, setDraft] = useState<Calendar | null>(null);
  useEffect(() => setDraft(cal ? structuredClone(cal) : null), [cal]);
  const holidays = useQuery({ queryKey: ['holidays', cal?.id], queryFn: () => api.get<{ data: { id: number; date: string; name: string }[] }>('/settings/holidays', { businessHoursId: cal!.id }), enabled: !!cal });
  const [hol, setHol] = useState({ date: '', name: '' });
  const save = useMutation({
    mutationFn: () => api.patch(`/settings/business-hours/${draft!.id}`, { name: draft!.name, timezone: draft!.timezone, schedule: draft!.schedule, isDefault: draft!.isDefault }),
    onSuccess: () => {
      toast.success('Calendar saved — new SLA deadlines use it immediately');
      qc.invalidateQueries({ queryKey: ['business-hours'] });
    },
    onError: (e) => handleFormError(e),
  });
  const create = useMutation({
    mutationFn: () => api.post<Calendar>('/settings/business-hours', { name: 'New calendar', timezone: 'UTC', schedule: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '17:00']], sat: [], sun: [] }, isDefault: false }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['business-hours'] });
      setSelected(c.id);
    },
  });
  const addHol = useMutation({
    mutationFn: () => api.post('/settings/holidays', { businessHoursId: cal!.id, ...hol }),
    onSuccess: () => {
      setHol({ date: '', name: '' });
      qc.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (e) => handleFormError(e),
  });
  const delHol = useMutation({ mutationFn: (id: number) => api.delete(`/settings/holidays/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays'] }) });
  if (!q.data) return <PageLoader />;
  const setDay = (day: string, ranges: [string, string][]) => setDraft((d) => (d ? { ...d, schedule: { ...d.schedule, [day]: ranges } } : d));
  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <Card className="h-fit p-2">
        {q.data.data.map((c) => (
          <button key={c.id} onClick={() => setSelected(c.id)} className={`block w-full cursor-pointer rounded px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 ${cal?.id === c.id ? 'bg-surface-2 font-medium' : ''}`}>
            {c.name} {c.isDefault && <Badge tone="primary">Default</Badge>}
            <div className="text-[11px] text-muted">{c.timezone}</div>
          </button>
        ))}
        <Button size="sm" variant="ghost" className="mt-1 w-full" onClick={() => create.mutate()}>
          <Plus /> New calendar
        </Button>
      </Card>
      {draft && (
        <div className="space-y-4">
          <Card>
            <CardBody className="space-y-4">
              <FormGrid cols={2}>
                <FormField label="Name">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                </FormField>
                <FormField label="Time zone">
                  <Select value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} options={timezoneOptions(draft.timezone)} />
                </FormField>
              </FormGrid>
              <Checkbox label="Default calendar" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />
              <div className="space-y-2">
                {DAYS.map(([key, label]) => {
                  const ranges = draft.schedule[key] ?? [];
                  return (
                    <div key={key} className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="w-24 font-medium">{label}</span>
                      {ranges.length === 0 && <span className="text-xs text-muted">Closed</span>}
                      {ranges.map((r, i) => (
                        <span key={i} className="flex items-center gap-1">
                          <Input type="time" value={r[0]} className="w-28" onChange={(e) => setDay(key, ranges.map((x, j) => (j === i ? [e.target.value, x[1]] : x)) as [string, string][])} />
                          –
                          <Input type="time" value={r[1]} className="w-28" onChange={(e) => setDay(key, ranges.map((x, j) => (j === i ? [x[0], e.target.value] : x)) as [string, string][])} />
                          <Button size="icon-sm" variant="ghost" onClick={() => setDay(key, ranges.filter((_, j) => j !== i))} aria-label="Remove range">
                            <X />
                          </Button>
                        </span>
                      ))}
                      <Button size="sm" variant="ghost" onClick={() => setDay(key, [...ranges, ['09:00', '17:00']])}>
                        <Plus /> Range
                      </Button>
                    </div>
                  );
                })}
              </div>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Save calendar
              </Button>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Holidays" description="SLA clocks do not run on holidays" />
            <CardBody className="space-y-3">
              <div className="flex gap-2">
                <Input type="date" value={hol.date} onChange={(e) => setHol({ ...hol, date: e.target.value })} className="w-44" />
                <Input value={hol.name} onChange={(e) => setHol({ ...hol, name: e.target.value })} placeholder="Holiday name" />
                <Button disabled={!hol.date || !hol.name} onClick={() => addHol.mutate()}>
                  <Plus /> Add
                </Button>
              </div>
              <ul className="divide-y divide-border">
                {(holidays.data?.data ?? []).map((h) => (
                  <li key={h.id} className="flex items-center gap-3 py-1.5 text-[13px]">
                    <span className="w-32 text-muted">{fmtDate(h.date)}</span>
                    <span className="flex-1">{h.name}</span>
                    <Button size="icon-sm" variant="ghost" onClick={() => delHol.mutate(h.id)} aria-label="Remove holiday">
                      <Trash2 />
                    </Button>
                  </li>
                ))}
                {(holidays.data?.data ?? []).length === 0 && <li className="py-2 text-xs text-muted">No holidays defined.</li>}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, Repeat, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { opts, useLookups, userOpts } from '@/lib/lookups';
import { fmtDateTime, fmtRelative, toLocalInput } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Badge, Card, EmptyState } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/overlays';
import { DataTable, type Column } from '@/components/data-table';
import { FormField, FormGrid, handleFormError } from '@/components/form';
import { EntityPicker } from '@/components/entity-picker';
import { TicketLink } from '@/lib/open-ticket';

interface Recurring {
  id: number;
  name: string;
  companyId: number;
  companyName: string;
  contactId: number | null;
  configurationItemId: number | null;
  title: string;
  description: string | null;
  queueId: number | null;
  priorityId: number | null;
  ticketTypeId: number | null;
  issueTypeId: number | null;
  subIssueTypeId: number | null;
  assignedUserId: number | null;
  assigneeName: string | null;
  estimatedHours: number | null;
  frequency: string;
  interval: number;
  dueInHours: number | null;
  nextRunAt: string;
  lastRunAt: string | null;
  lastTicketId: number | null;
  lastTicketNumber: string | null;
  isActive: boolean;
}

const FREQ: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };

export default function RecurringTicketsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const write = can('tickets.write');
  const q = useQuery({ queryKey: ['recurring-tickets'], queryFn: () => api.get<{ data: Recurring[] }>('/recurring-tickets') });
  const [editing, setEditing] = useState<Recurring | 'new' | null>(null);
  const run = useMutation({
    mutationFn: (id: number) => api.post<Recurring>(`/recurring-tickets/${id}/run`),
    onSuccess: (r) => {
      toast.success(`Ticket ${r.lastTicketNumber ?? ''} created`);
      qc.invalidateQueries({ queryKey: ['recurring-tickets'] });
      qc.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (e) => handleFormError(e),
  });
  const cols: Column<Recurring>[] = [
    { header: 'Schedule', cell: ({ row }) => <div><div className="font-medium">{row.original.name}</div><div className="text-[11px] text-muted">{row.original.title}</div></div> },
    { header: 'Company', cell: ({ row }) => <Link to={`/companies/${row.original.companyId}`} onClick={(e) => e.stopPropagation()} className="hover:text-primary">{row.original.companyName}</Link> },
    { header: 'Repeats', cell: ({ row }) => `Every ${row.original.interval > 1 ? `${row.original.interval} ` : ''}${FREQ[row.original.frequency]}${row.original.interval > 1 ? 's' : ''}` },
    { header: 'Assigned', cell: ({ row }) => row.original.assigneeName ?? <span className="text-subtle">Queue</span> },
    { header: 'Next run', cell: ({ row }) => <span title={fmtDateTime(row.original.nextRunAt)}>{row.original.isActive ? fmtRelative(row.original.nextRunAt) : <Badge>Paused</Badge>}</span> },
    {
      header: 'Last ticket',
      cell: ({ row }) =>
        row.original.lastTicketId ? (
          <TicketLink ticketId={row.original.lastTicketId} onClick={(e) => e.stopPropagation()} className="font-mono text-xs hover:text-primary">
            {row.original.lastTicketNumber}
          </TicketLink>
        ) : (
          '—'
        ),
    },
    {
      id: 'run',
      header: '',
      cell: ({ row }) =>
        write && (
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              run.mutate(row.original.id);
            }}
          >
            <Play /> Run now
          </Button>
        ),
    },
  ];
  return (
    <div>
      <PageHeader
        title="Recurring Tickets"
        icon={<Repeat />}
        subtitle="Scheduled tickets for preventive maintenance, health checks and routine tasks"
        actions={
          write && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus /> New schedule
            </Button>
          )
        }
      />
      <div className="p-5">
        <Card>
          <DataTable columns={cols} data={q.data?.data} loading={q.isLoading} onRowClick={(r) => write && setEditing(r)} empty={<EmptyState icon={<Repeat />} title="No recurring tickets" description="Example: a monthly server health check for each managed customer." />} />
        </Card>
      </div>
      {editing && <RecurringDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RecurringDialog({ item, onClose }: { item: Recurring | null; onClose: () => void }) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const L = lookups.data;
  const [f, setF] = useState({
    name: item?.name ?? '',
    companyId: item?.companyId ?? 0,
    contactId: item?.contactId ?? null,
    configurationItemId: item?.configurationItemId ?? null,
    title: item?.title ?? '',
    description: item?.description ?? '',
    queueId: item?.queueId ?? null,
    priorityId: item?.priorityId ?? null,
    ticketTypeId: item?.ticketTypeId ?? null,
    issueTypeId: item?.issueTypeId ?? null,
    subIssueTypeId: item?.subIssueTypeId ?? null,
    assignedUserId: item?.assignedUserId ?? null,
    estimatedHours: item?.estimatedHours?.toString() ?? '',
    frequency: item?.frequency ?? 'monthly',
    interval: item?.interval ?? 1,
    dueInHours: item?.dueInHours?.toString() ?? '',
    nextRunAt: toLocalInput(item?.nextRunAt ?? new Date(Date.now() + 86400_000)),
    isActive: item?.isActive ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const num = (v: string) => (v ? Number(v) : null);
  const sel = (k: keyof typeof f) => ({ value: f[k] == null ? '' : String(f[k]), onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setF({ ...f, [k]: num(e.target.value) }) });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, estimatedHours: f.estimatedHours || null, dueInHours: f.dueInHours || null, nextRunAt: new Date(f.nextRunAt).toISOString() };
      return item ? api.put(`/recurring-tickets/${item.id}`, body) : api.post('/recurring-tickets', body);
    },
    onSuccess: () => {
      toast.success('Schedule saved');
      qc.invalidateQueries({ queryKey: ['recurring-tickets'] });
      onClose();
    },
    onError: (e) => handleFormError(e, (n: string, err: { message: string }) => setErrors((x) => ({ ...x, [n]: err.message }))),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/recurring-tickets/${item!.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring-tickets'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? 'Edit schedule' : 'New recurring ticket'}
      size="lg"
      footer={
        <>
          {item && (
            <Button variant="ghost" className="mr-auto text-danger" onClick={() => remove.mutate()}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormGrid cols={2}>
          <FormField label="Schedule name" required error={errors.name}>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Monthly server check" />
          </FormField>
          <FormField label="Company" required error={errors.companyId}>
            <EntityPicker kind="company" value={f.companyId || null} label={item?.companyName} onChange={(id) => setF({ ...f, companyId: id ?? 0, contactId: null, configurationItemId: null })} />
          </FormField>
          <FormField label="Contact">
            <EntityPicker kind="contact" value={f.contactId} filter={{ companyId: f.companyId || undefined }} disabled={!f.companyId} onChange={(id) => setF({ ...f, contactId: id })} />
          </FormField>
          <FormField label="Configuration item">
            <EntityPicker kind="ci" value={f.configurationItemId} filter={{ companyId: f.companyId || undefined }} disabled={!f.companyId} onChange={(id) => setF({ ...f, configurationItemId: id })} />
          </FormField>
          <FormField label="Ticket title" required error={errors.title} className="sm:col-span-2">
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </FormField>
          <FormField label="Description / checklist" className="sm:col-span-2">
            <Textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </FormField>
        </FormGrid>
        <FormGrid cols={4}>
          <FormField label="Repeat every">
            <Input type="number" min={1} value={f.interval} onChange={(e) => setF({ ...f, interval: Number(e.target.value) })} />
          </FormField>
          <FormField label="Frequency">
            <Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })} options={Object.entries(FREQ).map(([v, l]) => ({ value: v, label: `${l}(s)` }))} />
          </FormField>
          <FormField label="Next run" error={errors.nextRunAt}>
            <Input type="datetime-local" value={f.nextRunAt} onChange={(e) => setF({ ...f, nextRunAt: e.target.value })} />
          </FormField>
          <FormField label="Due after (hours)">
            <Input type="number" min={1} value={f.dueInHours} onChange={(e) => setF({ ...f, dueInHours: e.target.value })} />
          </FormField>
          <FormField label="Queue">
            <Select {...sel('queueId')} placeholder="—" options={opts(L?.queues)} />
          </FormField>
          <FormField label="Priority">
            <Select {...sel('priorityId')} placeholder="Default" options={opts(L?.priorities)} />
          </FormField>
          <FormField label="Assign to">
            <Select {...sel('assignedUserId')} placeholder="Queue default" options={userOpts(L?.users)} />
          </FormField>
          <FormField label="Estimate (h)">
            <Input type="number" step="0.25" min={0} value={f.estimatedHours} onChange={(e) => setF({ ...f, estimatedHours: e.target.value })} />
          </FormField>
          <FormField label="Ticket type">
            <Select {...sel('ticketTypeId')} placeholder="—" options={opts(L?.ticketTypes)} />
          </FormField>
          <FormField label="Issue type">
            <Select value={f.issueTypeId ?? ''} onChange={(e) => setF({ ...f, issueTypeId: num(e.target.value), subIssueTypeId: null })} placeholder="—" options={opts(L?.issueTypes)} />
          </FormField>
          <FormField label="Sub-issue type">
            <Select {...sel('subIssueTypeId')} placeholder="—" disabled={!f.issueTypeId} options={(L?.subIssueTypes ?? []).filter((x) => x.issueTypeId === f.issueTypeId).map((x) => ({ value: x.id, label: x.name }))} />
          </FormField>
        </FormGrid>
        <Checkbox label="Active" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
      </div>
    </Dialog>
  );
}

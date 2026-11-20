import { useEffect, useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Workflow, X } from 'lucide-react';
import { toast } from 'sonner';
import { WORKFLOW_ACTION, WORKFLOW_FIELDS, WORKFLOW_OPERATOR, WORKFLOW_TRIGGER, type WorkflowActionType, type WorkflowField } from '@taskora/shared';
import { api, type Paginated } from '@/lib/api';
import { opts, useLookups, userOpts, type Lookups } from '@/lib/lookups';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui/misc';
import { Dialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { FormField, FormGrid, handleFormError } from '@/components/form';
import { DataTable, type Column } from '@/components/data-table';
import { EntityPicker } from '@/components/entity-picker';
import { TicketLink } from '@/lib/open-ticket';

interface Condition {
  field: WorkflowField;
  operator: string;
  value?: string | number | (string | number)[] | null;
}
interface Action {
  type: WorkflowActionType;
  value?: string | number | null;
}
interface Rule {
  id: number;
  name: string;
  description: string | null;
  trigger: string;
  delayMinutes: number | null;
  conditions: Condition[];
  actions: Action[];
  isActive: boolean;
  stopProcessing: boolean;
  sortOrder: number;
  executionCount: number;
  lastExecutedAt: string | null;
}

function fieldOptions(field: WorkflowField, L: Lookups | undefined) {
  switch (field) {
    case 'statusId':
      return opts(L?.statuses);
    case 'priorityId':
      return opts(L?.priorities);
    case 'queueId':
      return opts(L?.queues);
    case 'ticketTypeId':
      return opts(L?.ticketTypes);
    case 'issueTypeId':
      return opts(L?.issueTypes);
    case 'sourceId':
      return opts(L?.sources);
    case 'assignedUserId':
      return userOpts(L?.users);
    default:
      return null;
  }
}

function actionOptions(type: WorkflowActionType, L: Lookups | undefined) {
  switch (type) {
    case 'set_queue':
      return opts(L?.queues);
    case 'set_priority':
      return opts(L?.priorities);
    case 'set_status':
      return opts(L?.statuses);
    case 'assign_user':
    case 'notify_user':
      return userOpts(L?.users);
    case 'set_sla':
      return opts(L?.slaPolicies);
    default:
      return null;
  }
}

export default function WorkflowsPage() {
  const qc = useQueryClient();
  const lookups = useLookups();
  const rules = useQuery({ queryKey: ['workflow-rules'], queryFn: () => api.get<{ data: Rule[] }>('/workflow-rules') });
  const stats = useQuery({ queryKey: ['workflow-stats'], queryFn: () => api.get<{ data: { ruleId: number; success: number; failed: number }[] }>('/workflow-rules/stats') });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const toggle = useMutation({
    mutationFn: (r: Rule) => api.patch(`/workflow-rules/${r.id}/active`, { isActive: !r.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-rules'] }),
  });
  const cols: Column<Rule>[] = [
    { header: 'Order', meta: { className: 'w-14' }, cell: ({ row }) => <span className="text-muted">{row.original.sortOrder}</span> },
    { header: 'Rule', cell: ({ row }) => <div><div className="font-medium">{row.original.name}</div>{row.original.description && <div className="text-[11px] text-muted">{row.original.description}</div>}</div> },
    {
      header: 'When',
      cell: ({ row }) => (
        <span className="text-xs">
          {WORKFLOW_TRIGGER.labels[row.original.trigger as keyof typeof WORKFLOW_TRIGGER.labels]}
          {row.original.delayMinutes ? ` for ${row.original.delayMinutes} min` : ''}
          {row.original.conditions.length > 0 && <span className="text-muted"> · {row.original.conditions.length} condition(s)</span>}
        </span>
      ),
    },
    { header: 'Then', cell: ({ row }) => <span className="text-xs text-muted">{row.original.actions.map((a) => WORKFLOW_ACTION.labels[a.type]).join(', ')}</span> },
    {
      header: '30 days',
      cell: ({ row }) => {
        const s = stats.data?.data.find((x) => x.ruleId === row.original.id);
        return (
          <span className="text-xs">
            <span className="text-success">{s?.success ?? 0} ok</span>
            {s?.failed ? <span className="text-danger"> · {s.failed} failed</span> : null}
          </span>
        );
      },
    },
    { header: 'Last run', cell: ({ row }) => <span className="text-xs text-muted">{fmtRelative(row.original.lastExecutedAt, 'never')}</span> },
    {
      header: 'Active',
      cell: ({ row }) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={row.original.isActive} onChange={() => toggle.mutate(row.original)} />
        </span>
      ),
    },
  ];
  return (
    <div>
      <PageHeader
        title="Workflow Rules"
        icon={<Workflow />}
        subtitle="Automate routing, assignment, SLA and reminders. Changes made by rules never trigger other rules."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus /> New rule
          </Button>
        }
      />
      <div className="p-5">
        <Tabs defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules" count={rules.data?.data.length}>
              Rules
            </TabsTrigger>
            <TabsTrigger value="history">Execution history</TabsTrigger>
          </TabsList>
          <TabsContent value="rules" className="mt-4">
            <Card>
              <DataTable columns={cols} data={rules.data?.data} loading={rules.isLoading} onRowClick={(r) => setEditing(r)} empty={<EmptyState icon={<Workflow />} title="No workflow rules" description="Example: when a Critical ticket is created, route it to Level 2 and notify the on-call technician." />} />
            </Card>
          </TabsContent>
          <TabsContent value="history" className="mt-4">
            <Executions rules={rules.data?.data ?? []} />
          </TabsContent>
        </Tabs>
      </div>
      {editing && <RuleDialog rule={editing === 'new' ? null : editing} lookups={lookups.data} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ValueInput({ field, operator, value, onChange, L }: { field: WorkflowField; operator: string; value: Condition['value']; onChange: (v: Condition['value']) => void; L?: Lookups }) {
  if (operator === 'is_empty' || operator === 'is_not_empty') return <span className="text-xs text-muted">—</span>;
  const options = fieldOptions(field, L);
  if (field === 'companyId') return <EntityPicker kind="company" value={value ? Number(value) : null} onChange={(id) => onChange(id)} />;
  if (options && operator === 'in') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[12px]">
            <input type="checkbox" checked={selected.includes(String(o.value))} onChange={(e) => onChange(e.target.checked ? [...selected, String(o.value)] : selected.filter((x) => x !== String(o.value)))} />
            {o.label}
          </label>
        ))}
      </div>
    );
  }
  if (options) return <Select value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} placeholder="Select…" options={options} />;
  return <Input value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)} placeholder="Text" />;
}

function RuleDialog({ rule, lookups: L, onClose }: { rule: Rule | null; lookups?: Lookups; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: rule?.name ?? '',
    description: rule?.description ?? '',
    trigger: rule?.trigger ?? 'ticket.created',
    delayMinutes: rule?.delayMinutes ?? null,
    isActive: rule?.isActive ?? true,
    stopProcessing: rule?.stopProcessing ?? false,
    sortOrder: rule?.sortOrder ?? 0,
  });
  const [conditions, setConditions] = useState<Condition[]>(rule?.conditions ?? []);
  const [actions, setActions] = useState<Action[]>(rule?.actions ?? [{ type: 'notify_assignee' }]);
  const [testId, setTestId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  useEffect(() => setTestResult(null), [conditions, testId]);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, conditions, actions: actions.map((a) => ({ ...a, value: a.value === '' ? null : a.value })) };
      return rule ? api.put(`/workflow-rules/${rule.id}`, body) : api.post('/workflow-rules', body);
    },
    onSuccess: () => {
      toast.success('Rule saved');
      qc.invalidateQueries({ queryKey: ['workflow-rules'] });
      onClose();
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/workflow-rules/${rule!.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow-rules'] });
      onClose();
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ matches: boolean }>('/workflow-rules/test', { ticketId: testId, conditions }),
    onSuccess: (r) => setTestResult(r.matches),
    onError: (e) => handleFormError(e),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={rule ? `Edit rule: ${rule.name}` : 'New workflow rule'}
      size="xl"
      footer={
        <>
          {rule && (
            <Button variant="ghost" className="mr-auto text-danger" onClick={() => confirm('Delete this rule?') && remove.mutate()}>
              <Trash2 /> Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!f.name.trim() || actions.length === 0} loading={save.isPending} onClick={() => save.mutate()}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <FormGrid cols={3}>
          <FormField label="Name" required className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </FormField>
          <FormField label="Order">
            <Input type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} />
          </FormField>
          <FormField label="Description" className="sm:col-span-3">
            <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </FormField>
        </FormGrid>

        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">When</h4>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-72">
              <Select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })} options={WORKFLOW_TRIGGER.values.map((v) => ({ value: v, label: WORKFLOW_TRIGGER.labels[v] }))} />
            </div>
            {f.trigger === 'ticket.status_age' && (
              <>
                <span className="text-xs text-muted">for at least</span>
                <Input type="number" min={1} className="w-24" value={f.delayMinutes ?? ''} onChange={(e) => setF({ ...f, delayMinutes: e.target.value ? Number(e.target.value) : null })} />
                <span className="text-xs text-muted">minutes (fires once per status period)</span>
              </>
            )}
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">And all conditions match</h4>
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="grid grid-cols-[180px_150px_1fr_auto] items-start gap-2">
                <Select value={c.field} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { field: e.target.value as WorkflowField, operator: x.operator, value: null } : x)))} options={WORKFLOW_FIELDS.values.map((v) => ({ value: v, label: WORKFLOW_FIELDS.labels[v] }))} />
                <Select value={c.operator} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, operator: e.target.value, value: e.target.value === 'in' ? [] : null } : x)))} options={WORKFLOW_OPERATOR.values.map((v) => ({ value: v, label: WORKFLOW_OPERATOR.labels[v] }))} />
                <ValueInput field={c.field} operator={c.operator} value={c.value} L={L} onChange={(v) => setConditions(conditions.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
                <Button size="icon" variant="ghost" onClick={() => setConditions(conditions.filter((_, j) => j !== i))} aria-label="Remove condition">
                  <X />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setConditions([...conditions, { field: 'priorityId', operator: 'eq', value: null }])}>
              <Plus /> Add condition
            </Button>
            {conditions.length === 0 && <p className="text-xs text-muted">No conditions: the rule applies to every ticket for this trigger.</p>}
          </div>
        </section>

        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">Then</h4>
          <div className="space-y-2">
            {actions.map((a, i) => {
              const options = actionOptions(a.type, L);
              return (
                <div key={i} className="grid grid-cols-[220px_1fr_auto] items-center gap-2">
                  <Select value={a.type} onChange={(e) => setActions(actions.map((x, j) => (j === i ? { type: e.target.value as WorkflowActionType, value: null } : x)))} options={WORKFLOW_ACTION.values.map((v) => ({ value: v, label: WORKFLOW_ACTION.labels[v] }))} />
                  {a.type === 'notify_assignee' ? (
                    <span className="text-xs text-muted">Notifies the ticket's assigned technician</span>
                  ) : options ? (
                    <Select value={a.value == null ? '' : String(a.value)} onChange={(e) => setActions(actions.map((x, j) => (j === i ? { ...x, value: e.target.value ? Number(e.target.value) : null } : x)))} placeholder={a.type === 'assign_user' || a.type === 'set_queue' ? 'None (clear)' : 'Select…'} options={options} />
                  ) : (
                    <Input value={a.value == null ? '' : String(a.value)} onChange={(e) => setActions(actions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={a.type === 'add_tag' ? 'tag' : 'Note text'} />
                  )}
                  <Button size="icon" variant="ghost" onClick={() => setActions(actions.filter((_, j) => j !== i))} aria-label="Remove action">
                    <X />
                  </Button>
                </div>
              );
            })}
            <Button size="sm" variant="ghost" onClick={() => setActions([...actions, { type: 'add_note', value: '' }])}>
              <Plus /> Add action
            </Button>
          </div>
        </section>

        <div className="flex flex-wrap gap-4">
          <Checkbox label="Active" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          <Checkbox label="Stop evaluating later rules when this one runs" checked={f.stopProcessing} onChange={(e) => setF({ ...f, stopProcessing: e.target.checked })} />
        </div>

        <section className="rounded-md bg-surface-2 p-3">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">Test conditions against a ticket</h4>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <EntityPicker kind="ticket" value={testId} onChange={setTestId} placeholder="Pick a ticket…" />
            </div>
            <Button disabled={!testId} loading={test.isPending} onClick={() => test.mutate()}>
              Test
            </Button>
            {testResult !== null && <Badge tone={testResult ? 'success' : 'neutral'}>{testResult ? 'Matches' : 'Does not match'}</Badge>}
          </div>
        </section>
      </div>
    </Dialog>
  );
}

interface Execution {
  id: number;
  ruleId: number;
  ruleName: string;
  ticketId: number | null;
  ticketNumber: string | null;
  trigger: string;
  status: string;
  result: string[] | null;
  error: string | null;
  executedAt: string;
}

function Executions({ rules }: { rules: Rule[] }) {
  const [page, setPage] = useState(1);
  const [ruleId, setRuleId] = useState('');
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['workflow-executions', page, ruleId, status], queryFn: () => api.get<Paginated<Execution>>('/workflow-executions', { page, pageSize: 50, ruleId, status }) });
  const cols: Column<Execution>[] = [
    { header: 'Time', cell: ({ row }) => <span className="text-xs">{fmtDateTime(row.original.executedAt)}</span> },
    { header: 'Rule', cell: ({ row }) => row.original.ruleName },
    { header: 'Ticket', cell: ({ row }) => (row.original.ticketId ? <TicketLink ticketId={row.original.ticketId} className="font-mono text-xs hover:text-primary">{row.original.ticketNumber}</TicketLink> : '—') },
    { header: 'Trigger', cell: ({ row }) => <span className="text-xs text-muted">{row.original.trigger}</span> },
    { header: 'Status', cell: ({ row }) => <Badge tone={row.original.status === 'success' ? 'success' : row.original.status === 'failed' ? 'danger' : 'info'}>{row.original.status}</Badge> },
    { header: 'Result', cell: ({ row }) => <span className="text-xs text-muted">{row.original.error ?? row.original.result?.join(', ')}</span> },
  ];
  return (
    <Card>
      <CardHeader
        title="Executions"
        actions={
          <>
            <div className="w-56">
              <Select value={ruleId} onChange={(e) => setRuleId(e.target.value)} placeholder="All rules" options={rules.map((r) => ({ value: r.id, label: r.name }))} />
            </div>
            <div className="w-36">
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                placeholder="Any status"
                options={[
                  { value: 'success', label: 'Success' },
                  { value: 'failed', label: 'Failed' },
                ]}
              />
            </div>
          </>
        }
      />
      <DataTable columns={cols} data={q.data?.data} total={q.data?.total} page={page} pageSize={50} onPageChange={setPage} loading={q.isLoading} />
    </Card>
  );
}

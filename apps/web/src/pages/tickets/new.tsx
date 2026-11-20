import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { opts, useLookups, userOpts } from '@/lib/lookups';
import { fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Card, CardBody, CardHeader } from '@/components/ui/misc';
import { FormField, FormGrid, handleFormError } from '@/components/form';
import { EntityPicker } from '@/components/entity-picker';
import { CustomFieldsEditor } from '@/components/custom-fields';
import { StatusBadge } from '@/components/badges';
import { openTicketWindow, TicketLink, useTicketWindowPreferred } from '@/lib/open-ticket';

interface FormValues {
  title: string;
  description: string;
  companyId: number | null;
  contactId: number | null;
  configurationItemId: number | null;
  locationId: number | null;
  contractId: number | null;
  ticketTypeId: string;
  issueTypeId: string;
  subIssueTypeId: string;
  priorityId: string;
  statusId: string;
  queueId: string;
  sourceId: string;
  assignedUserId: string;
  dueAt: string;
  estimatedHours: string;
  customFields: Record<string, unknown>;
}

interface Template {
  id: number;
  name: string;
  title: string | null;
  description: string | null;
  queueId: number | null;
  ticketTypeId: number | null;
  issueTypeId: number | null;
  subIssueTypeId: number | null;
  priorityId: number | null;
  sourceId: number | null;
  estimatedHours: number | null;
  isActive: boolean;
}

const s = (v: number | null | undefined) => (v == null ? '' : String(v));
const n = (v: string) => (v ? Number(v) : null);

export default function NewTicketPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const preferWindow = useTicketWindowPreferred();
  const [params] = useSearchParams();
  const lookups = useLookups();
  const L = lookups.data;
  const [labels, setLabels] = useState<{ company?: string; contact?: string; ci?: string }>({});

  const form = useForm<FormValues>({
    defaultValues: {
      title: '',
      description: '',
      companyId: params.get('companyId') ? Number(params.get('companyId')) : null,
      contactId: params.get('contactId') ? Number(params.get('contactId')) : null,
      configurationItemId: params.get('ciId') ? Number(params.get('ciId')) : null,
      locationId: null,
      contractId: null,
      ticketTypeId: '',
      issueTypeId: '',
      subIssueTypeId: '',
      priorityId: '',
      statusId: '',
      queueId: '',
      sourceId: '',
      assignedUserId: '',
      dueAt: '',
      estimatedHours: '',
      customFields: {},
    },
  });
  const { register, control, watch, setValue, handleSubmit, setError, formState } = form;
  const companyId = watch('companyId');
  const contactId = watch('contactId');
  const issueTypeId = watch('issueTypeId');
  const ticketTypeId = watch('ticketTypeId');
  const title = watch('title');
  const ciId = watch('configurationItemId');

  // Defaults from configuration once loaded.
  useEffect(() => {
    if (!L) return;
    if (!form.getValues('priorityId')) setValue('priorityId', s(L.priorities.find((p) => p.isDefault)?.id));
    if (!form.getValues('sourceId')) setValue('sourceId', s(L.sources.find((x) => x.name === 'Phone')?.id ?? L.sources[0]?.id));
  }, [L, form, setValue]);

  const templates = useQuery({ queryKey: ['ticket-templates'], queryFn: () => api.get<{ data: Template[] }>('/settings/ticket-templates') });
  const applyTemplate = (id: string) => {
    const t = templates.data?.data.find((x) => x.id === Number(id));
    if (!t) return;
    if (t.title) setValue('title', t.title);
    if (t.description) setValue('description', t.description);
    setValue('ticketTypeId', s(t.ticketTypeId));
    setValue('issueTypeId', s(t.issueTypeId));
    setValue('subIssueTypeId', s(t.subIssueTypeId));
    if (t.priorityId) setValue('priorityId', s(t.priorityId));
    if (t.queueId) setValue('queueId', s(t.queueId));
    if (t.sourceId) setValue('sourceId', s(t.sourceId));
    if (t.estimatedHours) setValue('estimatedHours', String(t.estimatedHours));
    toast.message(`Template "${t.name}" applied`);
  };

  // Debounced duplicate detection.
  const [dupQuery, setDupQuery] = useState({ title: '', companyId: 0, ciId: 0, contactId: 0 });
  useEffect(() => {
    const t = setTimeout(() => setDupQuery({ title: title.trim(), companyId: companyId ?? 0, ciId: ciId ?? 0, contactId: contactId ?? 0 }), 400);
    return () => clearTimeout(t);
  }, [title, companyId, ciId, contactId]);
  const dups = useQuery({
    queryKey: ['duplicates', dupQuery],
    queryFn: () =>
      api.get<{ data: { id: number; ticketNumber: string; title: string; statusName: string; statusColor: string; createdAt: string }[] }>('/tickets/duplicates', {
        companyId: dupQuery.companyId,
        title: dupQuery.title,
        configurationItemId: dupQuery.ciId || undefined,
        contactId: dupQuery.contactId || undefined,
      }),
    enabled: !!dupQuery.companyId && (dupQuery.title.length > 6 || !!dupQuery.ciId),
  });

  // Contracts of the company for the contract picker.
  const contracts = useQuery({
    queryKey: ['contracts', 'company', companyId],
    queryFn: () => api.get<{ data: { id: number; name: string; contractNumber: string; isDefault: boolean }[] }>('/contracts', { companyId: companyId!, status: 'active', pageSize: 100 }),
    enabled: !!companyId,
  });

  const issueTypes = useMemo(() => (L?.issueTypes ?? []).filter((i) => i.isActive !== false && (!i.ticketTypeId || !ticketTypeId || i.ticketTypeId === Number(ticketTypeId))), [L, ticketTypeId]);
  const subIssues = useMemo(() => (L?.subIssueTypes ?? []).filter((x) => x.isActive !== false && x.issueTypeId === Number(issueTypeId)), [L, issueTypeId]);

  const create = useMutation({
    mutationFn: (v: FormValues) =>
      api.post<{ id: number; ticketNumber: string }>('/tickets', {
        title: v.title,
        description: v.description,
        companyId: v.companyId,
        contactId: v.contactId,
        configurationItemId: v.configurationItemId,
        locationId: v.locationId,
        contractId: v.contractId,
        ticketTypeId: n(v.ticketTypeId),
        issueTypeId: n(v.issueTypeId),
        subIssueTypeId: n(v.subIssueTypeId),
        priorityId: n(v.priorityId),
        statusId: n(v.statusId),
        queueId: n(v.queueId),
        sourceId: n(v.sourceId),
        assignedUserId: n(v.assignedUserId),
        dueAt: v.dueAt ? new Date(v.dueAt).toISOString() : null,
        estimatedHours: v.estimatedHours || null,
        customFields: v.customFields,
      }),
    onSuccess: (t) => {
      toast.success(`Ticket ${t.ticketNumber} created`);
      // In window mode the new ticket opens in its own window and this one goes back to where it came from.
      if (preferWindow && openTicketWindow(t.id)) navigate((location.state as { from?: string })?.from ?? '/tickets', { replace: true });
      else navigate(`/tickets/${t.id}`, { replace: true });
    },
    onError: (e) => handleFormError(e, setError),
  });

  const err = (k: keyof FormValues) => formState.errors[k]?.message as string | undefined;
  const from = (location.state as { from?: string })?.from;

  return (
    <div>
      <PageHeader
        title="New ticket"
        icon={<Ticket />}
        breadcrumbs={[{ label: 'Service Desk', to: '/tickets' }, { label: 'New ticket' }]}
        actions={
          (templates.data?.data ?? []).some((t) => t.isActive) && (
            <div className="w-56">
              <Select placeholder="Apply template…" onChange={(e) => applyTemplate(e.target.value)} value="" options={(templates.data?.data ?? []).filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name }))} />
            </div>
          )
        }
      />
      <form onSubmit={handleSubmit((v) => create.mutate(v))} className="grid gap-4 p-5 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Customer" />
            <CardBody>
              <FormGrid cols={3}>
                <FormField label="Company" required error={err('companyId')}>
                  <Controller
                    control={control}
                    name="companyId"
                    rules={{ required: 'Select a company' }}
                    render={({ field }) => (
                      <EntityPicker
                        kind="company"
                        value={field.value}
                        label={labels.company}
                        invalid={!!err('companyId')}
                        onChange={(id, o) => {
                          field.onChange(id);
                          setLabels({ company: o?.label });
                          setValue('contactId', null);
                          setValue('configurationItemId', null);
                          setValue('locationId', null);
                          setValue('contractId', null);
                        }}
                      />
                    )}
                  />
                </FormField>
                <FormField label="Contact" error={err('contactId')}>
                  <Controller
                    control={control}
                    name="contactId"
                    render={({ field }) => (
                      <EntityPicker
                        kind="contact"
                        value={field.value}
                        label={labels.contact}
                        filter={{ companyId: companyId ?? undefined, active: 'true' }}
                        disabled={!companyId}
                        placeholder={companyId ? 'Select contact…' : 'Select a company first'}
                        onChange={(id, o) => {
                          field.onChange(id);
                          setLabels((l) => ({ ...l, contact: o?.label }));
                        }}
                      />
                    )}
                  />
                </FormField>
                <FormField label="Configuration item" error={err('configurationItemId')}>
                  <Controller
                    control={control}
                    name="configurationItemId"
                    render={({ field }) => (
                      <EntityPicker
                        kind="ci"
                        value={field.value}
                        label={labels.ci}
                        filter={{ companyId: companyId ?? undefined }}
                        disabled={!companyId}
                        placeholder={companyId ? 'Select device…' : 'Select a company first'}
                        onChange={(id, o) => {
                          field.onChange(id);
                          setLabels((l) => ({ ...l, ci: o?.label }));
                        }}
                      />
                    )}
                  />
                </FormField>
              </FormGrid>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Issue" />
            <CardBody className="space-y-3">
              <FormField label="Title" required error={err('title')}>
                <Input {...register('title', { required: 'Enter a title' })} placeholder="Short summary of the issue" aria-invalid={!!err('title')} />
              </FormField>
              <FormField label="Description">
                <Textarea rows={7} {...register('description')} placeholder="Symptoms, error messages, steps to reproduce, business impact…" />
              </FormField>
              <FormGrid cols={3}>
                <FormField label="Ticket type">
                  <Select {...register('ticketTypeId')} placeholder="—" options={opts(L?.ticketTypes)} />
                </FormField>
                <FormField label="Issue type">
                  <Select
                    {...register('issueTypeId', { onChange: () => setValue('subIssueTypeId', '') })}
                    placeholder="—"
                    options={issueTypes.map((i) => ({ value: i.id, label: i.name }))}
                  />
                </FormField>
                <FormField label="Sub-issue type" error={err('subIssueTypeId')}>
                  <Select
                    {...register('subIssueTypeId', {
                      onChange: (e) => {
                        const sub = L?.subIssueTypes.find((x) => x.id === Number(e.target.value));
                        if (sub?.queueId && !form.getValues('queueId')) setValue('queueId', String(sub.queueId));
                      },
                    })}
                    placeholder={issueTypeId ? '—' : 'Select an issue type'}
                    disabled={!issueTypeId}
                    options={subIssues.map((i) => ({ value: i.id, label: i.name }))}
                  />
                </FormField>
              </FormGrid>
              <Controller control={control} name="customFields" render={({ field }) => <CustomFieldsEditor entity="ticket" value={field.value} onChange={field.onChange} errors={formState.errors} />} />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Routing" />
            <CardBody className="space-y-3">
              <FormGrid cols={2}>
                <FormField label="Priority">
                  <Select {...register('priorityId')} options={opts(L?.priorities)} />
                </FormField>
                <FormField label="Status">
                  <Select {...register('statusId')} placeholder="Default (New)" options={opts(L?.statuses)} />
                </FormField>
                <FormField label="Queue">
                  <Select {...register('queueId')} placeholder="—" options={opts(L?.queues)} />
                </FormField>
                <FormField label="Source">
                  <Select {...register('sourceId')} placeholder="—" options={opts(L?.sources)} />
                </FormField>
              </FormGrid>
              <FormField label="Assigned technician" hint="Leave empty to use the queue's default assignee">
                <Select {...register('assignedUserId')} placeholder="Unassigned" options={userOpts(L?.users)} />
              </FormField>
              <FormField label="Contract" hint="Defaults to the company's default contract">
                <Controller
                  control={control}
                  name="contractId"
                  render={({ field }) => (
                    <Select
                      value={s(field.value)}
                      onChange={(e) => field.onChange(n(e.target.value))}
                      disabled={!companyId}
                      placeholder="Default contract"
                      options={(contracts.data?.data ?? []).map((c) => ({ value: c.id, label: `${c.name}${c.isDefault ? ' (default)' : ''}` }))}
                    />
                  )}
                />
              </FormField>
              <FormGrid cols={2}>
                <FormField label="Due date">
                  <Input type="datetime-local" {...register('dueAt')} />
                </FormField>
                <FormField label="Estimated hours">
                  <Input type="number" step="0.25" min="0" {...register('estimatedHours')} />
                </FormField>
              </FormGrid>
            </CardBody>
          </Card>

          {(dups.data?.data ?? []).length > 0 && (
            <Card className="border-warning/50">
              <CardHeader
                title={
                  <span className="flex items-center gap-1.5 text-warning">
                    <AlertTriangle className="size-4" /> Possible duplicates
                  </span>
                }
                description="Open tickets of this company with a similar title or device"
              />
              <ul className="divide-y divide-border">
                {dups.data!.data.map((d) => (
                  <li key={d.id} className="px-4 py-2">
                    <TicketLink ticketId={d.id} className="block text-[13px] font-medium hover:text-primary">
                      <span className="font-mono text-xs text-muted">{d.ticketNumber}</span> {d.title}
                    </TicketLink>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                      <StatusBadge name={d.statusName} color={d.statusColor} /> {fmtRelative(d.createdAt)}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="flex gap-2">
            <Button type="button" onClick={() => navigate(from ?? '/tickets')}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1" loading={create.isPending}>
              Create ticket
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

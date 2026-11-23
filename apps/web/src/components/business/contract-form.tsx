import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BILLING_PERIOD, CONTRACT_STATUS, CONTRACT_TYPE } from '@taskora/shared';
import { api } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { todayIso } from '@/lib/utils';
import { Button } from '../ui/button';
import { Checkbox, Input, Select, Textarea } from '../ui/input';
import { Dialog } from '../ui/overlays';
import { FormField, FormGrid, FormSection, handleFormError } from '../form';
import { EntityPicker } from '../entity-picker';
import { CustomFieldsEditor } from '../custom-fields';
import { enumOpts } from './common';

export interface ContractRecord {
  id: number;
  contractNumber: string;
  name: string;
  companyId: number;
  companyName?: string | null;
  type: string;
  status: string;
  startDate: string;
  endDate: string | null;
  slaId: number | null;
  slaName?: string | null;
  contactId: number | null;
  contactName?: string | null;
  isDefault: boolean;
  autoRenew?: boolean;
  portalVisible?: boolean;
  hourlyRate: number | null;
  fixedAmount: number | null;
  recurringAmount: number | null;
  billingPeriod: string;
  overageRate: number | null;
  perTicketRate: number | null;
  description: string | null;
  customFields: Record<string, unknown>;
}

interface FormValues {
  name: string;
  companyId: number | null;
  type: string;
  status: string;
  startDate: string;
  endDate: string;
  slaId: string;
  contactId: number | null;
  isDefault: boolean;
  autoRenew: boolean;
  portalVisible: boolean;
  hourlyRate: string;
  fixedAmount: string;
  recurringAmount: string;
  billingPeriod: string;
  overageRate: string;
  perTicketRate: string;
  description: string;
  customFields: Record<string, unknown>;
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function toForm(c?: ContractRecord | null, companyId?: number | null): FormValues {
  return {
    name: c?.name ?? '',
    companyId: c?.companyId ?? companyId ?? null,
    type: c?.type ?? 'time_materials',
    status: c?.status ?? 'active',
    startDate: c?.startDate ?? todayIso(),
    endDate: c?.endDate ?? '',
    slaId: s(c?.slaId),
    contactId: c?.contactId ?? null,
    isDefault: c?.isDefault ?? false,
    autoRenew: c?.autoRenew ?? false,
    portalVisible: c?.portalVisible ?? true,
    hourlyRate: s(c?.hourlyRate),
    fixedAmount: s(c?.fixedAmount),
    recurringAmount: s(c?.recurringAmount),
    billingPeriod: c?.billingPeriod ?? 'monthly',
    overageRate: s(c?.overageRate),
    perTicketRate: s(c?.perTicketRate),
    description: c?.description ?? '',
    customFields: c?.customFields ?? {},
  };
}

/** Which commercial fields apply to each contract type. */
export const CONTRACT_FIELDS: Record<string, { hourly?: boolean; fixed?: boolean; recurring?: boolean; overage?: boolean; perTicket?: boolean }> = {
  time_materials: { hourly: true },
  fixed_price: { fixed: true, hourly: true },
  block_hours: { overage: true, hourly: true },
  retainer: { recurring: true, overage: true, hourly: true },
  recurring: { recurring: true, hourly: true },
  per_ticket: { perTicket: true, hourly: true },
};

/** One-line explanation of how each contract type is billed. */
export const CONTRACT_TYPE_HINTS: Record<string, string> = {
  time_materials: 'All billable time is invoiced at the contract or work type rates.',
  fixed_price: 'The fixed amount is invoiced once, on the first invoice covering the start date; billable time is included.',
  block_hours: 'Customers prepay hour blocks; time uses the remaining hours, oldest block first, and the excess is billed at the overage rate.',
  retainer: 'A recurring fee every billing period; with hour blocks, time beyond them is billed at the overage rate.',
  recurring: 'A recurring fee (plus services) every billing period; billable time is included.',
  per_ticket: 'A fixed fee per ticket resolved in the invoice period; time on the tickets is included.',
};

export function ContractFormDialog({
  open,
  onOpenChange,
  contract,
  companyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contract?: ContractRecord | null;
  companyId?: number | null;
  onSaved?: (c: ContractRecord) => void;
}) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const { register, handleSubmit, reset, setError, control, formState, watch, setValue } = useForm<FormValues>({ defaultValues: toForm() });

  useEffect(() => {
    if (open) reset(toForm(contract, companyId));
  }, [open, contract, companyId, reset]);

  const type = watch('type');
  const selectedCompany = watch('companyId');
  const f = CONTRACT_FIELDS[type] ?? {};

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = {
        name: v.name,
        type: v.type,
        status: v.status,
        startDate: v.startDate,
        endDate: v.endDate || null,
        slaId: v.slaId ? Number(v.slaId) : null,
        contactId: v.contactId,
        isDefault: v.isDefault,
        autoRenew: v.autoRenew,
        portalVisible: v.portalVisible,
        hourlyRate: f.hourly ? v.hourlyRate || null : null,
        fixedAmount: f.fixed ? v.fixedAmount || null : null,
        recurringAmount: f.recurring ? v.recurringAmount || null : null,
        billingPeriod: f.recurring ? v.billingPeriod : contract?.billingPeriod ?? 'monthly',
        overageRate: f.overage ? v.overageRate || null : null,
        perTicketRate: f.perTicket ? v.perTicketRate || null : null,
        description: v.description || null,
        customFields: v.customFields,
      };
      return contract ? api.patch<ContractRecord>(`/contracts/${contract.id}`, body) : api.post<ContractRecord>('/contracts', { ...body, companyId: v.companyId });
    },
    onSuccess: (row) => {
      toast.success(contract ? 'Contract updated' : 'Contract created');
      qc.invalidateQueries({ queryKey: ['contracts'] });
      qc.invalidateQueries({ queryKey: ['contract', row.id] });
      onOpenChange(false);
      onSaved?.(row);
    },
    onError: (e) => handleFormError(e, setError),
  });

  const err = (k: keyof FormValues) => formState.errors[k]?.message as string | undefined;
  const submit = handleSubmit((v) => save.mutate(v));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={contract ? `Edit ${contract.contractNumber}` : 'New contract'}
      size="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {contract ? 'Save changes' : 'Create contract'}
          </Button>
        </>
      }
    >
      <form className="space-y-5" onSubmit={submit}>
        <FormSection title="General">
          <FormGrid cols={3}>
            <FormField label="Contract name" required error={err('name')} className="sm:col-span-2">
              <Input {...register('name')} aria-invalid={!!err('name')} placeholder="e.g. Managed services 2026" />
            </FormField>
            <FormField label="Company" required error={err('companyId')} hint={contract ? 'The company cannot be changed' : undefined}>
              <Controller
                control={control}
                name="companyId"
                render={({ field }) => (
                  <EntityPicker
                    kind="company"
                    value={field.value}
                    onChange={(id) => {
                      field.onChange(id);
                      setValue('contactId', null);
                    }}
                    label={contract?.companyName}
                    disabled={!!contract}
                    invalid={!!err('companyId')}
                    placeholder="Select company…"
                  />
                )}
              />
            </FormField>
            <FormField label="Type" required hint={CONTRACT_TYPE_HINTS[type]} className="sm:col-span-2">
              <Select {...register('type')} options={enumOpts(CONTRACT_TYPE)} />
            </FormField>
            <FormField label="Status">
              <Select {...register('status')} options={enumOpts(CONTRACT_STATUS)} />
            </FormField>
            <FormField label="SLA policy" hint="Applied to tickets on this contract">
              <Select {...register('slaId')} placeholder="Company / system default" options={opts(lookups.data?.slaPolicies, contract?.slaId)} />
            </FormField>
            <FormField label="Start date" required error={err('startDate')}>
              <Input type="date" {...register('startDate')} aria-invalid={!!err('startDate')} />
            </FormField>
            <FormField label="End date" error={err('endDate')}>
              <Input type="date" {...register('endDate')} aria-invalid={!!err('endDate')} />
            </FormField>
            <FormField label="Customer contact">
              <Controller
                control={control}
                name="contactId"
                render={({ field }) => (
                  <EntityPicker
                    kind="contact"
                    value={field.value}
                    onChange={field.onChange}
                    label={contract?.contactName}
                    filter={{ companyId: selectedCompany }}
                    disabled={!selectedCompany}
                    placeholder="None"
                  />
                )}
              />
            </FormField>
          </FormGrid>
          <Checkbox label="Default contract for this company (applied to new tickets)" {...register('isDefault')} />
          <Checkbox label="Renews automatically at the end date" {...register('autoRenew')} />
          <Checkbox label="Show in the client portal (Contract & billing)" {...register('portalVisible')} />
        </FormSection>

        <FormSection title="Commercial terms">
          <FormGrid cols={3}>
            {f.fixed && (
              <FormField label="Fixed amount" error={err('fixedAmount')} hint="Invoiced once, with the contract start">
                <Input type="number" step="0.01" min="0" {...register('fixedAmount')} />
              </FormField>
            )}
            {f.recurring && (
              <FormField label="Recurring amount" error={err('recurringAmount')} hint="Invoiced every billing period">
                <Input type="number" step="0.01" min="0" {...register('recurringAmount')} />
              </FormField>
            )}
            {f.recurring && (
              <FormField label="Billing period" hint="Periods start on the contract start date">
                <Select {...register('billingPeriod')} options={enumOpts(BILLING_PERIOD)} />
              </FormField>
            )}
            {f.perTicket && (
              <FormField label="Per-ticket rate" error={err('perTicketRate')} hint="Invoiced for every ticket resolved">
                <Input type="number" step="0.01" min="0" {...register('perTicketRate')} />
              </FormField>
            )}
            {f.overage && (
              <FormField label="Overage rate" error={err('overageRate')} hint={type === 'retainer' ? 'Per hour beyond the retainer blocks' : 'Per hour beyond purchased hours'}>
                <Input type="number" step="0.01" min="0" {...register('overageRate')} />
              </FormField>
            )}
            {f.hourly && (
              <FormField
                label="Hourly rate"
                error={err('hourlyRate')}
                hint={type === 'time_materials' ? 'Overrides work type rates' : type === 'block_hours' ? 'Used for excluded work types (overage rate wins otherwise)' : 'For billable time not covered (e.g. excluded work types)'}
              >
                <Input type="number" step="0.01" min="0" {...register('hourlyRate')} />
              </FormField>
            )}
          </FormGrid>
          {(type === 'block_hours' || type === 'retainer') && <p className="text-xs text-muted">Hour blocks are added on the contract's Blocks tab after it is created; unpaid blocks with an amount are invoiced.</p>}
        </FormSection>

        <Controller control={control} name="customFields" render={({ field }) => <CustomFieldsEditor entity="contract" value={field.value} onChange={field.onChange} errors={formState.errors} />} />
        <FormField label="Description / scope">
          <Textarea rows={3} {...register('description')} />
        </FormField>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

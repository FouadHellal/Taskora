import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { todayIso } from '@/lib/utils';
import { Button } from '../ui/button';
import { Checkbox, Input, Select, Textarea } from '../ui/input';
import { Dialog } from '../ui/overlays';
import { Badge, EmptyState, Spinner } from '../ui/misc';
import { FormField, FormGrid, handleFormError } from '../form';
import { EntityPicker } from '../entity-picker';
import { useMoney } from './common';

/* ------------------------------------------------------------ invoice draft */

interface DraftForm {
  companyId: number | null;
  periodStart: string;
  periodEnd: string;
  taxRate: string;
  includeTime: boolean;
  includeExpenses: boolean;
  includeRecurring: boolean;
  notes: string;
}

/** Billing defaults (system default tax rate) for the draft form. */
export function useBillingDefaults(enabled = true) {
  return useQuery({ queryKey: ['billing-defaults'], queryFn: () => api.get<{ defaultTaxRate: number; currency: string }>('/billing/defaults'), enabled, staleTime: 60_000 });
}

export function InvoiceDraftDialog({
  open,
  onOpenChange,
  company,
  periodStart,
  periodEnd,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  company?: { id: number; name: string } | null;
  periodStart: string;
  periodEnd: string;
  onCreated: (invoice: { id: number; invoiceNumber: string }) => void;
}) {
  const qc = useQueryClient();
  const defaults = useBillingDefaults(open);
  const defaultTax = defaults.data ? String(defaults.data.defaultTaxRate) : '';
  const { register, handleSubmit, reset, setError, control, formState } = useForm<DraftForm>();
  useEffect(() => {
    if (open) reset({ companyId: company?.id ?? null, periodStart, periodEnd, taxRate: defaultTax, includeTime: true, includeExpenses: true, includeRecurring: true, notes: '' });
  }, [open, company, periodStart, periodEnd, defaultTax, reset]);

  const create = useMutation({
    mutationFn: (v: DraftForm) => api.post<{ id: number; invoiceNumber: string; lines: unknown[] }>('/invoices/draft', { ...v, taxRate: v.taxRate === '' ? null : v.taxRate, notes: v.notes || null }),
    onSuccess: (inv) => {
      toast.success(`Draft ${inv.invoiceNumber} created with ${inv.lines.length} line${inv.lines.length === 1 ? '' : 's'}`);
      qc.invalidateQueries({ queryKey: ['billing-review'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['expenses'] });
      onOpenChange(false);
      onCreated(inv);
    },
    onError: (e) => handleFormError(e, setError),
  });
  const err = (k: keyof DraftForm) => formState.errors[k]?.message as string | undefined;
  const submit = handleSubmit((v) => create.mutate(v));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={company ? `Invoice draft · ${company.name}` : 'New invoice draft'}
      description="Collects unbilled approved time (including block overage), billable expenses and contract charges for the period."
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={submit}>
            Create draft
          </Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        {!company && (
          <FormField label="Company" required error={err('companyId')}>
            <Controller control={control} name="companyId" render={({ field }) => <EntityPicker kind="company" value={field.value} onChange={field.onChange} invalid={!!err('companyId')} />} />
          </FormField>
        )}
        <FormGrid>
          <FormField label="Period start" required error={err('periodStart')}>
            <Input type="date" {...register('periodStart')} />
          </FormField>
          <FormField label="Period end" required error={err('periodEnd')}>
            <Input type="date" {...register('periodEnd')} />
          </FormField>
          <FormField label="Tax rate (%)" error={err('taxRate')} hint={defaults.data ? `Default ${defaults.data.defaultTaxRate}%` : undefined}>
            <Input type="number" min="0" max="100" step="0.01" {...register('taxRate')} />
          </FormField>
        </FormGrid>
        <div className="flex flex-col gap-1.5">
          <Checkbox label="Approved billable time" {...register('includeTime')} />
          <Checkbox label="Billable expenses" {...register('includeExpenses')} />
          <Checkbox label="Contract charges: recurring fees, services, fixed price, hour blocks, per-ticket fees" {...register('includeRecurring')} />
        </div>
        <FormField label="Notes (printed on the invoice)">
          <Textarea rows={2} {...register('notes')} />
        </FormField>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------- billing preview */

interface PreviewLine {
  kind: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}
interface Preview {
  companyName: string;
  currency: string;
  lines: PreviewLine[];
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
}

export const LINE_KIND_LABELS: Record<string, string> = {
  service: 'Recurring',
  fixed: 'Fixed price',
  block: 'Hour block',
  ticket: 'Per ticket',
  time: 'Time',
  expense: 'Expense',
  manual: 'Manual',
};
const KIND_TONE: Record<string, 'info' | 'primary' | 'warning' | 'success' | 'neutral'> = { service: 'info', fixed: 'primary', block: 'warning', ticket: 'primary', time: 'success', expense: 'neutral' };

/** Shows what the next invoice draft would contain for a company and period, without creating anything. */
export function BillingPreviewDialog({
  open,
  onOpenChange,
  company,
  periodStart,
  periodEnd,
  onCreateDraft,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  company?: { id: number; name: string } | null;
  periodStart: string;
  periodEnd: string;
  onCreateDraft?: (company: { id: number; name: string }, period: { from: string; to: string }) => void;
}) {
  const money = useMoney();
  const [companyId, setCompanyId] = useState<number | null>(company?.id ?? null);
  const [from, setFrom] = useState(periodStart);
  const [to, setTo] = useState(periodEnd);
  useEffect(() => {
    if (!open) return;
    setCompanyId(company?.id ?? null);
    setFrom(periodStart);
    setTo(periodEnd);
  }, [open, company, periodStart, periodEnd]);
  const preview = useQuery({
    queryKey: ['billing-preview', companyId, from, to],
    queryFn: () => api.get<Preview>('/billing/preview', { companyId: companyId!, periodStart: from, periodEnd: to }),
    enabled: open && !!companyId && !!from && !!to && from <= to,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const p = preview.data;
  const m = (n: number) => money(n, p?.currency);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={company ? `Billing preview · ${company.name}` : 'Billing preview'}
      description="What an invoice draft for this period would contain. Nothing is created."
      size="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          {onCreateDraft && (
            <Button variant="primary" disabled={!companyId || !p?.lines.length} onClick={() => companyId && onCreateDraft({ id: companyId, name: p?.companyName ?? company?.name ?? '' }, { from, to })}>
              Create invoice draft
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <FormGrid cols={3}>
          {!company && (
            <FormField label="Company" required>
              <EntityPicker kind="company" value={companyId} onChange={setCompanyId} />
            </FormField>
          )}
          <FormField label="Period start">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField label="Period end">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
        </FormGrid>
        {!companyId ? (
          <p className="text-[13px] text-muted">Select a company to preview its next invoice.</p>
        ) : preview.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : preview.isError ? (
          <p className="text-[13px] text-danger">{(preview.error as Error).message}</p>
        ) : p && p.lines.length ? (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-3 py-1.5">Type</th>
                  <th className="px-3 py-1.5">Description</th>
                  <th className="px-3 py-1.5 text-right">Qty</th>
                  <th className="px-3 py-1.5 text-right">Unit price</th>
                  <th className="px-3 py-1.5 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-1.5">
                      <Badge tone={KIND_TONE[l.kind] ?? 'neutral'}>{LINE_KIND_LABELS[l.kind] ?? l.kind}</Badge>
                    </td>
                    <td className="px-3 py-1.5">{l.description}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{l.quantity}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{m(l.unitPrice)}</td>
                    <td className="px-3 py-1.5 text-right font-medium tabular-nums">{m(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="text-[13px]">
                <tr className="border-t border-border">
                  <td colSpan={4} className="px-3 py-1 text-right text-muted">
                    Subtotal
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">{m(p.subtotal)}</td>
                </tr>
                <tr>
                  <td colSpan={4} className="px-3 py-1 text-right text-muted">
                    Tax ({p.taxRate}%)
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">{m(p.taxAmount)}</td>
                </tr>
                <tr>
                  <td colSpan={4} className="px-3 py-1 text-right font-semibold">
                    Total
                  </td>
                  <td className="px-3 py-1 text-right font-semibold tabular-nums">{m(p.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <EmptyState title="Nothing to bill" description="No unbilled time, expenses or contract charges in this period." />
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ expense */

interface ExpenseForm {
  companyId: number | null;
  ticketId: number | null;
  projectId: number | null;
  billingCodeId: string;
  expenseDate: string;
  description: string;
  amount: string;
  billable: boolean;
}

export function ExpenseDialog({ open, onOpenChange, companyId }: { open: boolean; onOpenChange: (o: boolean) => void; companyId?: number | null }) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const { register, handleSubmit, reset, setError, control, formState, watch, setValue } = useForm<ExpenseForm>();
  useEffect(() => {
    if (open) reset({ companyId: companyId ?? null, ticketId: null, projectId: null, billingCodeId: '', expenseDate: todayIso(), description: '', amount: '', billable: true });
  }, [open, companyId, reset]);
  const company = watch('companyId');
  const save = useMutation({
    mutationFn: (v: ExpenseForm) => api.post('/expenses', { ...v, billingCodeId: v.billingCodeId ? Number(v.billingCodeId) : null }),
    onSuccess: () => {
      toast.success('Expense added');
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['billing-review'] });
      onOpenChange(false);
    },
    onError: (e) => handleFormError(e, setError),
  });
  const err = (k: keyof ExpenseForm) => formState.errors[k]?.message as string | undefined;
  const submit = handleSubmit((v) => save.mutate(v));
  const codes = (lookups.data?.billingCodes ?? []).filter((c) => c.kind !== 'labor' && c.kind !== 'labour');
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add expense"
      size="md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Add expense
          </Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={submit}>
        <FormGrid>
          <FormField label="Company" required error={err('companyId')}>
            <Controller
              control={control}
              name="companyId"
              render={({ field }) => (
                <EntityPicker
                  kind="company"
                  value={field.value}
                  onChange={(id) => {
                    field.onChange(id);
                    setValue('ticketId', null);
                    setValue('projectId', null);
                  }}
                  invalid={!!err('companyId')}
                />
              )}
            />
          </FormField>
          <FormField label="Date" required error={err('expenseDate')}>
            <Input type="date" {...register('expenseDate')} />
          </FormField>
          <FormField label="Ticket" error={err('ticketId')}>
            <Controller control={control} name="ticketId" render={({ field }) => <EntityPicker kind="ticket" value={field.value} onChange={field.onChange} filter={{ companyId: company }} disabled={!company} placeholder="None" />} />
          </FormField>
          <FormField label="Project" error={err('projectId')}>
            <Controller control={control} name="projectId" render={({ field }) => <EntityPicker kind="project" value={field.value} onChange={field.onChange} filter={{ companyId: company }} disabled={!company} placeholder="None" />} />
          </FormField>
          <FormField label="Amount" required error={err('amount')}>
            <Input type="number" min="0" step="0.01" {...register('amount')} aria-invalid={!!err('amount')} />
          </FormField>
          <FormField label="Billing code">
            <Select {...register('billingCodeId')} placeholder="—" options={opts(codes, null, (c) => `${c.code} · ${c.name}`)} />
          </FormField>
        </FormGrid>
        <FormField label="Description" required error={err('description')}>
          <Input {...register('description')} aria-invalid={!!err('description')} placeholder="e.g. Travel to site, replacement SSD" />
        </FormField>
        <Checkbox label="Billable to customer" {...register('billable')} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

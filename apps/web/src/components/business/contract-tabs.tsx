import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Package, Pencil, Plus, Save, Timer, Trash2 } from 'lucide-react';
import { BILLING_PERIOD } from '@taskora/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLookups } from '@/lib/lookups';
import { fmtDate, todayIso } from '@/lib/utils';
import { Button } from '../ui/button';
import { Checkbox, Input } from '../ui/input';
import { Badge, Card, CardHeader, EmptyState } from '../ui/misc';
import { ConfirmDialog, Dialog } from '../ui/overlays';
import { FormField, FormGrid, handleFormError } from '../form';
import { EntityPicker } from '../entity-picker';
import { labelOf, useMoney } from './common';

export interface ContractRate {
  id: number;
  workTypeId: number;
  workTypeName: string;
  hourlyRate: number;
}
export interface ContractBlock {
  id: number;
  hours: number;
  amount: number | null;
  startDate: string;
  endDate: string | null;
  isPaid: boolean;
}
export interface ContractServiceLine {
  id: number;
  serviceId: number;
  serviceName: string;
  period: string;
  quantity: number;
  unitPrice: number;
  startDate: string | null;
}
interface ServiceRow {
  id: number;
  name: string;
  unitPrice: number;
  period: string;
  isActive: boolean;
}

const th = 'border-b border-border bg-surface-2 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted';
const td = 'border-b border-border px-3 py-1.5 align-middle';

/* -------------------------------------------------------------------- rates */

export function ContractRatesTab({ contractId, rates, contractRate }: { contractId: number; rates: ContractRate[]; contractRate: number | null }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const money = useMoney();
  const lookups = useLookups();
  const editable = can('contracts.write');
  const initial = useMemo(() => Object.fromEntries(rates.map((r) => [r.workTypeId, String(r.hourlyRate)])), [rates]);
  const [values, setValues] = useState<Record<number, string>>(initial);
  useEffect(() => setValues(initial), [initial]);
  const workTypes = (lookups.data?.workTypes ?? []).filter((w) => w.isActive !== false || initial[w.id] !== undefined);
  const dirty = JSON.stringify(Object.entries(values).filter(([, v]) => v !== '')) !== JSON.stringify(Object.entries(initial));

  const save = useMutation({
    mutationFn: () =>
      api.put(
        `/contracts/${contractId}/rates`,
        Object.entries(values)
          .filter(([, v]) => v !== '' && v !== undefined)
          .map(([k, v]) => ({ workTypeId: Number(k), hourlyRate: Number(v) })),
      ),
    onSuccess: () => {
      toast.success('Rates saved');
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
    },
    onError: (e) => handleFormError(e),
  });

  return (
    <Card>
      <CardHeader
        title="Rates per work type"
        description={`Precedence: contract work-type rate → contract hourly rate${contractRate != null ? ` (${money(contractRate)})` : ''} → work type default.`}
        actions={
          editable && (
            <Button variant="primary" size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              <Save /> Save rates
            </Button>
          )
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className={th}>Work type</th>
              <th className={th}>Billable</th>
              <th className={`${th} text-right`}>Default rate</th>
              <th className={`${th} w-48 text-right`}>Contract rate</th>
            </tr>
          </thead>
          <tbody>
            {workTypes.map((w) => (
              <tr key={w.id}>
                <td className={td}>
                  {w.name}
                  {w.code && <span className="ml-1.5 text-xs text-muted">{w.code}</span>}
                </td>
                <td className={td}>{w.isBillable ? <Badge tone="success">Billable</Badge> : <Badge>Non-billable</Badge>}</td>
                <td className={`${td} text-right tabular-nums text-muted`}>{w.hourlyRate != null ? money(w.hourlyRate) : '—'}</td>
                <td className={`${td} text-right`}>
                  {editable ? (
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      className="ml-auto h-7 w-32 text-right"
                      placeholder="Inherit"
                      value={values[w.id] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [w.id]: e.target.value }))}
                    />
                  ) : values[w.id] ? (
                    money(Number(values[w.id]))
                  ) : (
                    <span className="text-subtle">Inherit</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!workTypes.length && <EmptyState title="No work types" description="Configure work types under Admin → Ticket settings." />}
    </Card>
  );
}

/* ------------------------------------------------------------------- blocks */

interface BlockForm {
  hours: string;
  amount: string;
  startDate: string;
  endDate: string;
  isPaid: boolean;
}

export function ContractBlocksTab({ contractId, blocks, usedHours, overageRate }: { contractId: number; blocks: ContractBlock[]; usedHours: number; overageRate: number | null }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const money = useMoney();
  const editable = can('contracts.write');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ContractBlock | null>(null);
  const { register, handleSubmit, reset, setError, formState } = useForm<BlockForm>({ defaultValues: { hours: '', amount: '', startDate: todayIso(), endDate: '', isPaid: false } });
  useEffect(() => {
    if (adding) reset({ hours: '', amount: '', startDate: todayIso(), endDate: '', isPaid: false });
  }, [adding, reset]);

  const add = useMutation({
    mutationFn: (v: BlockForm) => api.post(`/contracts/${contractId}/blocks`, { ...v, amount: v.amount || null, endDate: v.endDate || null }),
    onSuccess: () => {
      toast.success('Block added');
      setAdding(false);
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['contracts'] });
    },
    onError: (e) => handleFormError(e, setError),
  });
  const remove = useMutation({
    mutationFn: (b: ContractBlock) => api.delete(`/contracts/${contractId}/blocks/${b.id}`),
    onSuccess: () => {
      toast.success('Block removed');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['contracts'] });
    },
    onError: (e) => handleFormError(e),
  });

  const purchased = blocks.reduce((a, b) => a + b.hours, 0);
  const err = (k: keyof BlockForm) => formState.errors[k]?.message as string | undefined;

  return (
    <Card>
      <CardHeader
        title="Purchased hour blocks"
        description={`${purchased} h purchased · ${usedHours} h used (contract-covered time)${overageRate != null ? ` · overage ${money(overageRate)}/h` : ''}`}
        actions={
          editable && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add block
            </Button>
          )
        }
      />
      {blocks.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                <th className={th}>Start</th>
                <th className={th}>End</th>
                <th className={`${th} text-right`}>Hours</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={th}>Payment</th>
                <th className={`${th} w-10`} />
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id}>
                  <td className={td}>{fmtDate(b.startDate)}</td>
                  <td className={td}>{b.endDate ? fmtDate(b.endDate) : <span className="text-subtle">No expiry</span>}</td>
                  <td className={`${td} text-right tabular-nums`}>{b.hours} h</td>
                  <td className={`${td} text-right tabular-nums`}>{b.amount != null ? money(b.amount) : '—'}</td>
                  <td className={td}>{b.isPaid ? <Badge tone="success">Paid</Badge> : <Badge tone="warning">Unpaid</Badge>}</td>
                  <td className={td}>
                    {editable && (
                      <Button size="icon-sm" variant="ghost" aria-label="Delete block" onClick={() => setDeleting(b)}>
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={<Timer />} title="No hour blocks" description="Add prepaid hour blocks to track consumption against this contract." />
      )}
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        title="Add hour block"
        size="sm"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" loading={add.isPending} onClick={handleSubmit((v) => add.mutate(v))}>
              Add block
            </Button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={handleSubmit((v) => add.mutate(v))}>
          <FormGrid>
            <FormField label="Hours" required error={err('hours')}>
              <Input type="number" step="0.25" min="0" {...register('hours')} aria-invalid={!!err('hours')} />
            </FormField>
            <FormField label="Amount" error={err('amount')}>
              <Input type="number" step="0.01" min="0" {...register('amount')} />
            </FormField>
            <FormField label="Start date" required error={err('startDate')}>
              <Input type="date" {...register('startDate')} />
            </FormField>
            <FormField label="Expires" error={err('endDate')}>
              <Input type="date" {...register('endDate')} />
            </FormField>
          </FormGrid>
          <Checkbox label="Paid" {...register('isPaid')} />
          <button type="submit" hidden />
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete hour block?"
        description={deleting ? `The block of ${deleting.hours} h starting ${fmtDate(deleting.startDate)} will be removed.` : undefined}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Card>
  );
}

/* ----------------------------------------------------------------- services */

export function ContractServicesTab({ contractId, services }: { contractId: number; services: ContractServiceLine[] }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const money = useMoney();
  const editable = can('contracts.write');
  const [editing, setEditing] = useState<ContractServiceLine | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ContractServiceLine | null>(null);
  const remove = useMutation({
    mutationFn: (l: ContractServiceLine) => api.delete(`/contracts/${contractId}/services/${l.id}`),
    onSuccess: () => {
      toast.success('Service removed');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
    },
    onError: (e) => handleFormError(e),
  });
  const total = services.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
  return (
    <Card>
      <CardHeader
        title="Recurring services"
        description={`Billed with the contract's recurring invoice · ${money(total)} per period`}
        actions={
          editable && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> Add service
            </Button>
          )
        }
      />
      {services.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                <th className={th}>Service</th>
                <th className={th}>Period</th>
                <th className={th}>Start</th>
                <th className={`${th} text-right`}>Qty</th>
                <th className={`${th} text-right`}>Unit price</th>
                <th className={`${th} text-right`}>Total</th>
                <th className={`${th} w-20`} />
              </tr>
            </thead>
            <tbody>
              {services.map((l) => (
                <tr key={l.id}>
                  <td className={`${td} font-medium`}>{l.serviceName}</td>
                  <td className={td}>{labelOf(BILLING_PERIOD, l.period)}</td>
                  <td className={td}>{fmtDate(l.startDate)}</td>
                  <td className={`${td} text-right tabular-nums`}>{l.quantity}</td>
                  <td className={`${td} text-right tabular-nums`}>{money(l.unitPrice)}</td>
                  <td className={`${td} text-right font-medium tabular-nums`}>{money(l.quantity * l.unitPrice)}</td>
                  <td className={`${td} text-right`}>
                    {editable && (
                      <div className="flex justify-end gap-0.5">
                        <Button size="icon-sm" variant="ghost" aria-label="Edit service" onClick={() => setEditing(l)}>
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label="Remove service" onClick={() => setDeleting(l)}>
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="px-3 py-2 text-right text-xs font-medium text-muted">
                  Total per period
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <EmptyState icon={<Package />} title="No services" description="Add services from the service catalog to bill them every period." />
      )}
      <ServiceLineDialog contractId={contractId} line={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove service?"
        description={deleting ? `${deleting.serviceName} will no longer be billed on this contract.` : undefined}
        confirmLabel="Remove"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </Card>
  );
}

interface LineForm {
  serviceId: number | null;
  quantity: string;
  unitPrice: string;
  startDate: string;
}

function ServiceLineDialog({ contractId, line, onClose }: { contractId: number; line: ContractServiceLine | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = line === 'new';
  const existing = line && line !== 'new' ? line : null;
  const catalog = useQuery({ queryKey: ['services', 'catalog'], queryFn: () => api.get<{ data: ServiceRow[] }>('/services'), enabled: !!line, staleTime: 60_000 });
  const [v, setV] = useState<LineForm>({ serviceId: null, quantity: '1', unitPrice: '', startDate: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!line) return;
    setErrors({});
    setV(existing ? { serviceId: existing.serviceId, quantity: String(existing.quantity), unitPrice: String(existing.unitPrice), startDate: existing.startDate ?? '' } : { serviceId: null, quantity: '1', unitPrice: '', startDate: todayIso() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line]);
  const selected = catalog.data?.data.find((s) => s.id === v.serviceId);
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.patch(`/contracts/${contractId}/services/${existing.id}`, { quantity: v.quantity, unitPrice: v.unitPrice === '' ? null : v.unitPrice })
        : api.post(`/contracts/${contractId}/services`, { serviceId: v.serviceId, quantity: v.quantity, unitPrice: v.unitPrice === '' ? null : v.unitPrice, startDate: v.startDate || null }),
    onSuccess: () => {
      toast.success(existing ? 'Service updated' : 'Service added');
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      onClose();
    },
    onError: (e) => handleFormError(e, (name: string, err: { message: string }) => setErrors((x) => ({ ...x, [name]: err.message }))),
  });
  return (
    <Dialog
      open={!!line}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? `Edit ${existing.serviceName}` : 'Add service'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} disabled={isNew && !v.serviceId}>
            {existing ? 'Save' : 'Add service'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {isNew && (
          <FormField label="Service" required error={errors.serviceId}>
            <EntityPicker
              kind="service"
              value={v.serviceId}
              onChange={(id) => {
                const svc = catalog.data?.data.find((s) => s.id === id);
                setV((x) => ({ ...x, serviceId: id, unitPrice: svc ? String(svc.unitPrice) : x.unitPrice }));
              }}
              placeholder="Select from catalog…"
            />
          </FormField>
        )}
        <FormGrid>
          <FormField label="Quantity" required error={errors.quantity}>
            <Input type="number" min="0" step="0.01" value={v.quantity} onChange={(e) => setV((x) => ({ ...x, quantity: e.target.value }))} />
          </FormField>
          <FormField label="Unit price" error={errors.unitPrice} hint={selected ? `Catalog price ${selected.unitPrice}` : 'Leave empty for the catalog price'}>
            <Input type="number" min="0" step="0.01" value={v.unitPrice} onChange={(e) => setV((x) => ({ ...x, unitPrice: e.target.value }))} />
          </FormField>
          {isNew && (
            <FormField label="Start date" error={errors.startDate}>
              <Input type="date" value={v.startDate} onChange={(e) => setV((x) => ({ ...x, startDate: e.target.value }))} />
            </FormField>
          )}
        </FormGrid>
      </div>
    </Dialog>
  );
}

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
import { Badge, Card, CardBody, CardHeader, EmptyState } from '../ui/misc';
import { Progress } from '../charts';
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
  usedHours: number;
  remainingHours: number;
  expired: boolean;
  active: boolean;
}
export interface ContractExclusion {
  workTypeId: number;
  workTypeName: string;
}
export interface ContractServiceLine {
  id: number;
  serviceId: number;
  serviceName: string;
  period: string;
  quantity: number;
  autoQuantity: boolean;
  quantitySource: 'manual' | 'devices' | 'users';
  ciTypeName: string | null;
  unitPrice: number;
  startDate: string | null;
  endDate: string | null;
}
interface ServiceRow {
  id: number;
  name: string;
  unitPrice: number;
  period: string;
  quantitySource: 'manual' | 'devices' | 'users';
  isActive: boolean;
}

const countWhat = (l: { quantitySource: string; ciTypeName?: string | null }) =>
  l.quantitySource === 'users' ? 'active contacts' : l.ciTypeName ? `active ${l.ciTypeName.toLowerCase()} devices` : 'active devices';

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

export interface BlockSummary {
  purchasedHours: number;
  usedHours: number;
  remainingHours: number;
  overageMinutes: number;
  lowBalance: boolean;
}

const blockForm = (b?: ContractBlock | null): BlockForm =>
  b
    ? { hours: String(b.hours), amount: b.amount != null ? String(b.amount) : '', startDate: b.startDate, endDate: b.endDate ?? '', isPaid: b.isPaid }
    : { hours: '', amount: '', startDate: todayIso(), endDate: '', isPaid: false };

export function ContractBlocksTab({ contractId, blocks, summary, overageRate }: { contractId: number; blocks: ContractBlock[]; summary: BlockSummary; overageRate: number | null }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const money = useMoney();
  const editable = can('contracts.write');
  const [editing, setEditing] = useState<ContractBlock | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ContractBlock | null>(null);
  const existing = editing && editing !== 'new' ? editing : null;
  const { register, handleSubmit, reset, setError, formState } = useForm<BlockForm>({ defaultValues: blockForm() });
  useEffect(() => {
    if (editing) reset(blockForm(existing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, reset]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['contract', contractId] });
    qc.invalidateQueries({ queryKey: ['contracts'] });
  };
  const save = useMutation({
    mutationFn: (v: BlockForm) => {
      const body = { ...v, amount: v.amount || null, endDate: v.endDate || null };
      return existing ? api.patch(`/contracts/${contractId}/blocks/${existing.id}`, body) : api.post(`/contracts/${contractId}/blocks`, body);
    },
    onSuccess: () => {
      toast.success(existing ? 'Block updated' : 'Block added');
      setEditing(null);
      invalidate();
    },
    onError: (e) => handleFormError(e, setError),
  });
  const remove = useMutation({
    mutationFn: (b: ContractBlock) => api.delete(`/contracts/${contractId}/blocks/${b.id}`),
    onSuccess: () => {
      toast.success('Block removed');
      setDeleting(null);
      invalidate();
    },
    onError: (e) => {
      setDeleting(null);
      handleFormError(e);
    },
  });

  const err = (k: keyof BlockForm) => formState.errors[k]?.message as string | undefined;
  const livePurchased = blocks.filter((b) => !b.expired).reduce((a, b) => a + b.hours, 0);
  const usedPct = livePurchased ? ((livePurchased - summary.remainingHours) / livePurchased) * 100 : 0;
  const submit = handleSubmit((v) => save.mutate(v));

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Hour blocks
            {summary.lowBalance && <Badge tone="danger">Low balance</Badge>}
          </span>
        }
        description={`${summary.purchasedHours} h purchased · ${summary.usedHours} h used · ${summary.remainingHours} h remaining${
          summary.overageMinutes ? ` · ${(summary.overageMinutes / 60).toFixed(2)} h overage` : ''
        }${overageRate != null ? ` · overage ${money(overageRate)}/h` : ''}`}
        actions={
          editable && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> Add block
            </Button>
          )
        }
      />
      {blocks.length > 0 && (
        <CardBody className="border-b border-border">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>Balance of non-expired blocks</span>
            <span className="tabular-nums">
              {summary.remainingHours} of {livePurchased} h left
            </span>
          </div>
          <Progress value={usedPct} tone={summary.lowBalance ? 'danger' : usedPct >= 80 ? 'warning' : 'primary'} className="mt-1" />
        </CardBody>
      )}
      {blocks.length ? (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                <th className={th}>Start</th>
                <th className={th}>Expires</th>
                <th className={`${th} text-right`}>Purchased</th>
                <th className={`${th} text-right`}>Used</th>
                <th className={`${th} text-right`}>Remaining</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={th}>Status</th>
                <th className={`${th} w-20`} />
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id} className={b.expired ? 'text-muted' : undefined}>
                  <td className={td}>{fmtDate(b.startDate)}</td>
                  <td className={td}>{b.endDate ? fmtDate(b.endDate) : <span className="text-subtle">No expiry</span>}</td>
                  <td className={`${td} text-right tabular-nums`}>{b.hours} h</td>
                  <td className={`${td} text-right tabular-nums`}>{b.usedHours} h</td>
                  <td className={`${td} text-right font-medium tabular-nums`}>{b.expired ? <span className="text-subtle line-through">{b.remainingHours} h</span> : `${b.remainingHours} h`}</td>
                  <td className={`${td} text-right tabular-nums`}>{b.amount != null ? money(b.amount) : '—'}</td>
                  <td className={td}>
                    <span className="flex flex-wrap gap-1">
                      {b.isPaid ? <Badge tone="success">Paid</Badge> : <Badge tone="warning">Unpaid</Badge>}
                      {b.expired ? <Badge>Expired</Badge> : !b.active ? <Badge tone="info">Not started</Badge> : null}
                    </span>
                  </td>
                  <td className={`${td} text-right`}>
                    {editable && (
                      <div className="flex justify-end gap-0.5">
                        <Button size="icon-sm" variant="ghost" aria-label="Edit block" onClick={() => setEditing(b)}>
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label="Delete block" onClick={() => setDeleting(b)}>
                          <Trash2 />
                        </Button>
                      </div>
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
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={existing ? 'Edit hour block' : 'Add hour block'}
        size="sm"
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={submit}>
              {existing ? 'Save' : 'Add block'}
            </Button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={submit}>
          <FormGrid>
            <FormField label="Hours" required error={err('hours')}>
              <Input type="number" step="0.25" min="0" {...register('hours')} aria-invalid={!!err('hours')} />
            </FormField>
            <FormField label="Amount" error={err('amount')} hint="Unpaid blocks with an amount are invoiced">
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

/* --------------------------------------------------------------- exclusions */

export function ContractExclusionsCard({ contractId, exclusions }: { contractId: number; exclusions: ContractExclusion[] }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const lookups = useLookups();
  const editable = can('contracts.write');
  const initial = useMemo(() => exclusions.map((x) => x.workTypeId).sort((a, b) => a - b), [exclusions]);
  const [selected, setSelected] = useState<number[]>(initial);
  useEffect(() => setSelected(initial), [initial]);
  const dirty = JSON.stringify([...selected].sort((a, b) => a - b)) !== JSON.stringify(initial);
  const save = useMutation({
    mutationFn: () => api.put(`/contracts/${contractId}/exclusions`, { workTypeIds: selected }),
    onSuccess: () => {
      toast.success('Exclusions saved');
      qc.invalidateQueries({ queryKey: ['contract', contractId] });
      qc.invalidateQueries({ queryKey: ['contracts'] });
    },
    onError: (e) => handleFormError(e),
  });
  const workTypes = (lookups.data?.workTypes ?? []).filter((w) => w.isBillable !== false && (w.isActive !== false || initial.includes(w.id)));
  return (
    <Card>
      <CardHeader
        title="Billable exclusions"
        description="Work types that stay billable even when this contract would cover the time."
        actions={
          editable && (
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              <Save /> Save
            </Button>
          )
        }
      />
      <CardBody className="flex flex-col gap-1.5">
        {editable ? (
          workTypes.map((w) => (
            <Checkbox
              key={w.id}
              label={w.name}
              checked={selected.includes(w.id)}
              onChange={(e) => setSelected((cur) => ((e.target as HTMLInputElement).checked ? [...cur, w.id] : cur.filter((x) => x !== w.id)))}
            />
          ))
        ) : exclusions.length ? (
          <div className="flex flex-wrap gap-1">
            {exclusions.map((x) => (
              <Badge key={x.workTypeId}>{x.workTypeName}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-[13px] text-subtle">None</span>
        )}
        {editable && !workTypes.length && <span className="text-[13px] text-subtle">No billable work types.</span>}
      </CardBody>
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
        description={`Billed on invoice drafts each service period (from the contract start, prorated for partial periods) · ${money(total)} per period`}
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
                <th className={th}>End</th>
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
                  <td className={td}>{l.endDate ? fmtDate(l.endDate) : <span className="text-subtle">—</span>}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    {l.quantity}
                    {l.autoQuantity && <div className="text-[10px] text-muted">auto · {countWhat(l)}</div>}
                  </td>
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
                <td colSpan={6} className="px-3 py-2 text-right text-xs font-medium text-muted">
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
  autoQuantity: boolean;
  unitPrice: string;
  startDate: string;
  endDate: string;
}

function ServiceLineDialog({ contractId, line, onClose }: { contractId: number; line: ContractServiceLine | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = line === 'new';
  const existing = line && line !== 'new' ? line : null;
  const catalog = useQuery({ queryKey: ['services', 'catalog'], queryFn: () => api.get<{ data: ServiceRow[] }>('/services'), enabled: !!line, staleTime: 60_000 });
  const [v, setV] = useState<LineForm>({ serviceId: null, quantity: '1', autoQuantity: false, unitPrice: '', startDate: '', endDate: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!line) return;
    setErrors({});
    setV(
      existing
        ? { serviceId: existing.serviceId, quantity: String(existing.quantity), autoQuantity: existing.autoQuantity, unitPrice: String(existing.unitPrice), startDate: existing.startDate ?? '', endDate: existing.endDate ?? '' }
        : { serviceId: null, quantity: '1', autoQuantity: false, unitPrice: '', startDate: todayIso(), endDate: '' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line]);
  const selected = catalog.data?.data.find((s) => s.id === v.serviceId);
  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.patch(`/contracts/${contractId}/services/${existing.id}`, {
            quantity: v.quantity,
            autoQuantity: v.autoQuantity,
            unitPrice: v.unitPrice === '' ? null : v.unitPrice,
            startDate: v.startDate || null,
            endDate: v.endDate || null,
          })
        : api.post(`/contracts/${contractId}/services`, {
            serviceId: v.serviceId,
            quantity: v.quantity,
            autoQuantity: v.autoQuantity,
            unitPrice: v.unitPrice === '' ? null : v.unitPrice,
            startDate: v.startDate || null,
            endDate: v.endDate || null,
          }),
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
                setV((x) => ({ ...x, serviceId: id, unitPrice: svc ? String(svc.unitPrice) : x.unitPrice, autoQuantity: !!svc && svc.quantitySource !== 'manual' }));
              }}
              placeholder="Select from catalog…"
            />
          </FormField>
        )}
        {(existing ? existing.quantitySource : selected?.quantitySource ?? 'manual') !== 'manual' && (
          <div className="rounded-md border border-border bg-surface-2 p-2.5">
            <Checkbox
              label="Count automatically"
              checked={v.autoQuantity}
              onChange={(e) => setV((x) => ({ ...x, autoQuantity: e.target.checked }))}
            />
            <p className="ml-6 mt-0.5 text-[11px] text-muted">
              Quantity = the client’s {existing ? countWhat(existing) : selected?.quantitySource === 'users' ? 'active contacts' : 'active devices of the service’s type'}, updated every day and whenever the contract is opened.
            </p>
          </div>
        )}
        <FormGrid>
          <FormField label="Quantity" required error={errors.quantity}>
            <Input type="number" min="0" step="0.01" value={v.quantity} disabled={v.autoQuantity} onChange={(e) => setV((x) => ({ ...x, quantity: e.target.value }))} />
          </FormField>
          <FormField label="Unit price" error={errors.unitPrice} hint={selected ? `Catalog price ${selected.unitPrice}` : 'Leave empty for the catalog price'}>
            <Input type="number" min="0" step="0.01" value={v.unitPrice} onChange={(e) => setV((x) => ({ ...x, unitPrice: e.target.value }))} />
          </FormField>
          <FormField label="Start date" error={errors.startDate} hint="Empty = contract start">
            <Input type="date" value={v.startDate} onChange={(e) => setV((x) => ({ ...x, startDate: e.target.value }))} />
          </FormField>
          <FormField label="End date" error={errors.endDate} hint="Last billed day; empty = contract end">
            <Input type="date" value={v.endDate} onChange={(e) => setV((x) => ({ ...x, endDate: e.target.value }))} />
          </FormField>
        </FormGrid>
      </div>
    </Dialog>
  );
}

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Receipt, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney, INVOICE_STATUS } from '@taskora/shared';
import { api, downloadUrl } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, PageLoader } from '@/components/ui/misc';
import { ConfirmDialog } from '@/components/ui/overlays';
import { handleFormError } from '@/components/form';

interface Line {
  id: number;
  kind: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  timeEntryId: number | null;
}
interface Invoice {
  id: number;
  invoiceNumber: string;
  companyId: number;
  companyName: string;
  status: 'draft' | 'issued' | 'paid' | 'void';
  issueDate: string | null;
  dueDate: string | null;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  currency: string;
  notes: string | null;
  lines: Line[];
}

const TONE = { draft: 'warning', issued: 'info', paid: 'success', void: 'neutral' } as const;

export default function InvoiceDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const write = can('billing.write');
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/invoices/${id}`) });
  const [line, setLine] = useState({ description: '', quantity: '1', unitPrice: '' });
  const [confirm, setConfirm] = useState<'void' | 'delete' | null>(null);
  const done = (msg?: string) => {
    if (msg) toast.success(msg);
    qc.invalidateQueries({ queryKey: ['invoice', id] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
  };
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/invoices/${id}`, body), onSuccess: () => done('Invoice updated'), onError: (e) => handleFormError(e) });
  const addLine = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/lines`, { description: line.description, quantity: Number(line.quantity), unitPrice: Number(line.unitPrice) }),
    onSuccess: () => {
      setLine({ description: '', quantity: '1', unitPrice: '' });
      done();
    },
    onError: (e) => handleFormError(e),
  });
  const delLine = useMutation({ mutationFn: (lineId: number) => api.delete(`/invoices/${id}/lines/${lineId}`), onSuccess: () => done(), onError: (e) => handleFormError(e) });
  const remove = useMutation({
    mutationFn: () => api.delete(`/invoices/${id}`),
    onSuccess: () => {
      toast.success('Draft deleted; time and expenses released');
      navigate('/invoices');
    },
    onError: (e) => handleFormError(e),
  });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <EmptyState title="Invoice not found" />;
  const inv = q.data;
  const money = (n: number) => formatMoney(n, inv.currency);
  const draft = inv.status === 'draft';
  return (
    <div>
      <PageHeader
        title={`Invoice ${inv.invoiceNumber}`}
        icon={<Receipt />}
        breadcrumbs={[{ label: 'Invoices', to: '/invoices' }, { label: inv.invoiceNumber }]}
        subtitle={
          <span className="flex items-center gap-2">
            <Badge tone={TONE[inv.status]}>{INVOICE_STATUS.labels[inv.status]}</Badge>
            <Link to={`/companies/${inv.companyId}`} className="text-primary hover:underline">
              {inv.companyName}
            </Link>
            <span>
              · {fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}
            </span>
          </span>
        }
        actions={
          <>
            <Button onClick={() => downloadUrl(`/invoices/${id}/pdf`)}>
              <Download /> PDF
            </Button>
            {write && draft && (
              <Button variant="primary" loading={update.isPending} onClick={() => update.mutate({ status: 'issued' })}>
                Issue invoice
              </Button>
            )}
            {write && inv.status === 'issued' && (
              <Button variant="primary" loading={update.isPending} onClick={() => update.mutate({ status: 'paid' })}>
                Mark paid
              </Button>
            )}
            {write && (draft || inv.status === 'issued') && <Button onClick={() => setConfirm('void')}>Void</Button>}
            {write && draft && (
              <Button variant="ghost" onClick={() => setConfirm('delete')} aria-label="Delete draft">
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 p-5 xl:grid-cols-[1fr_300px]">
        <Card>
          <CardHeader title="Lines" description={draft ? 'Draft: lines can still be changed' : undefined} />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Description</th>
                  <th className="px-4 py-2 text-right">Qty</th>
                  <th className="px-4 py-2 text-right">Unit price</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="px-4 py-1.5">
                      <Badge>{l.kind}</Badge>
                    </td>
                    <td className="px-4 py-1.5">{l.description}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{l.quantity}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{money(l.unitPrice)}</td>
                    <td className="px-4 py-1.5 text-right font-medium tabular-nums">{money(l.amount)}</td>
                    <td className="pr-2 text-right">
                      {write && draft && (
                        <Button size="icon-sm" variant="ghost" onClick={() => delLine.mutate(l.id)} aria-label="Remove line">
                          <X />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {inv.lines.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-xs text-muted">
                      No lines.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {write && draft && (
            <div className="flex gap-2 border-t border-border p-3">
              <Input value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} placeholder="Manual line description" />
              <Input type="number" value={line.quantity} onChange={(e) => setLine({ ...line, quantity: e.target.value })} className="w-20" aria-label="Quantity" />
              <Input type="number" step="0.01" value={line.unitPrice} onChange={(e) => setLine({ ...line, unitPrice: e.target.value })} placeholder="Unit price" className="w-32" />
              <Button disabled={!line.description || line.unitPrice === ''} loading={addLine.isPending} onClick={() => addLine.mutate()}>
                Add line
              </Button>
            </div>
          )}
        </Card>
        <aside className="space-y-4">
          <Card>
            <CardHeader title="Totals" />
            <CardBody className="space-y-2 text-[13px]">
              <div className="flex justify-between">
                <span className="text-muted">Subtotal</span>
                <span className="tabular-nums">{money(inv.subtotal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted">Tax</span>
                {write && draft ? (
                  <span className="flex items-center gap-1">
                    <Input type="number" min={0} max={100} defaultValue={inv.taxRate} className="h-7 w-16" onBlur={(e) => Number(e.target.value) !== inv.taxRate && update.mutate({ taxRate: Number(e.target.value) })} />%
                  </span>
                ) : (
                  <span>{inv.taxRate}%</span>
                )}
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Tax amount</span>
                <span className="tabular-nums">{money(inv.taxAmount)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{money(inv.total)}</span>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Dates & notes" />
            <CardBody className="space-y-3">
              <dl className="grid grid-cols-2 gap-3">
                <Field label="Issued">{fmtDate(inv.issueDate, '') || null}</Field>
                <Field label="Due">{fmtDate(inv.dueDate, '') || null}</Field>
              </dl>
              {write && inv.status !== 'void' ? (
                <Textarea rows={3} defaultValue={inv.notes ?? ''} placeholder="Notes printed on the invoice" onBlur={(e) => e.target.value !== (inv.notes ?? '') && update.mutate({ notes: e.target.value })} />
              ) : (
                inv.notes && <p className="prose-note text-[13px]">{inv.notes}</p>
              )}
            </CardBody>
          </Card>
        </aside>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'void' ? 'Void this invoice?' : 'Delete this draft?'}
        description="Time entries and expenses on this invoice become available for billing again."
        danger
        confirmLabel={confirm === 'void' ? 'Void invoice' : 'Delete draft'}
        loading={update.isPending || remove.isPending}
        onConfirm={() => (confirm === 'void' ? update.mutate({ status: 'void' }, { onSuccess: () => setConfirm(null) }) : remove.mutate())}
      />
    </div>
  );
}

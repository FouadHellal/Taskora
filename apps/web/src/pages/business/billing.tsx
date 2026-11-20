import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { endOfMonth, format, startOfMonth, subMonths } from 'date-fns';
import { Banknote, Eye, FilePlus2, Plus, Receipt, Trash2 } from 'lucide-react';
import { formatMinutes } from '@taskora/shared';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/utils';
import { useTableState } from '@/hooks/use-table-state';
import { DataTable, type Column } from '@/components/data-table';
import { FilterSelect, PageHeader, SearchInput } from '@/components/page';
import { EntityPicker } from '@/components/entity-picker';
import { handleFormError } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Stat } from '@/components/ui/misc';
import { ConfirmDialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { useMoney, useTabParam } from '@/components/business/common';
import { BillingPreviewDialog, ExpenseDialog, InvoiceDraftDialog } from '@/components/business/billing-dialogs';

interface ReviewRow {
  companyId: number;
  companyName: string;
  billableMinutes: number;
  pendingApprovalMinutes: number;
  contractCoveredMinutes: number;
  billableAmount: number;
  expenseCount: number;
  expenseAmount: number;
}

interface ExpenseRow {
  id: number;
  userId: number;
  userName: string;
  companyId: number;
  companyName: string;
  ticketId: number | null;
  ticketNumber: string | null;
  projectId: number | null;
  billingCodeName: string | null;
  expenseDate: string;
  description: string;
  amount: number;
  billable: boolean;
  invoiceId: number | null;
  invoiceNumber: string | null;
}

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

export default function BillingPage() {
  const [tab, setTab] = useTabParam('review');
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col">
      <PageHeader title="Billing" subtitle="Review unbilled work, create invoice drafts and record expenses" icon={<Banknote />}>
        <TabsList className="border-b-0">
          <TabsTrigger value="review">Billing review</TabsTrigger>
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
        </TabsList>
      </PageHeader>
      <TabsContent value="review" className="min-h-0 flex-1">
        <ReviewTab />
      </TabsContent>
      <TabsContent value="expenses" className="min-h-0 flex-1">
        <ExpensesTab />
      </TabsContent>
    </Tabs>
  );
}

function ReviewTab() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const money = useMoney();
  const now = new Date();
  const [from, setFrom] = useState(ymd(startOfMonth(now)));
  const [to, setTo] = useState(ymd(endOfMonth(now)));
  const [draftFor, setDraftFor] = useState<{ id: number; name: string } | null | 'new'>(null);
  const [previewFor, setPreviewFor] = useState<{ id: number; name: string } | null | 'new'>(null);
  const [draftPeriod, setDraftPeriod] = useState<{ from: string; to: string } | null>(null);
  const review = useQuery({
    queryKey: ['billing-review', from, to],
    queryFn: () => api.get<{ data: ReviewRow[] }>('/billing/review', { from, to }),
    placeholderData: keepPreviousData,
  });
  const rows = review.data?.data;
  const sum = (k: keyof ReviewRow) => (rows ?? []).reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const preset = (d: Date) => {
    setFrom(ymd(startOfMonth(d)));
    setTo(ymd(endOfMonth(d)));
  };

  const columns: Column<ReviewRow>[] = [
    {
      header: 'Company',
      cell: ({ row }) => (
        <Link to={`/companies/${row.original.companyId}`} className="font-medium hover:text-primary">
          {row.original.companyName}
        </Link>
      ),
    },
    { header: 'Billable hours', meta: { align: 'right' }, cell: ({ row }) => formatMinutes(row.original.billableMinutes) },
    { header: 'Billable amount', meta: { align: 'right' }, cell: ({ row }) => <span className="font-medium">{money(row.original.billableAmount)}</span> },
    {
      header: 'Pending approval',
      meta: { align: 'right' },
      cell: ({ row }) =>
        row.original.pendingApprovalMinutes ? (
          <Link to={`/time?userId=all&status=submitted,draft&companyId=${row.original.companyId}&from=${from}&to=${to}`} className="text-warning hover:underline">
            {formatMinutes(row.original.pendingApprovalMinutes)}
          </Link>
        ) : (
          <span className="text-subtle">—</span>
        ),
    },
    { header: 'Contract covered', meta: { align: 'right' }, cell: ({ row }) => <span className="text-muted">{formatMinutes(row.original.contractCoveredMinutes)}</span> },
    {
      header: 'Expenses',
      meta: { align: 'right' },
      cell: ({ row }) => (row.original.expenseCount ? `${money(row.original.expenseAmount)} (${row.original.expenseCount})` : <span className="text-subtle">—</span>),
    },
    { header: 'To invoice', meta: { align: 'right' }, cell: ({ row }) => <span className="font-semibold">{money(row.original.billableAmount + row.original.expenseAmount)}</span> },
    {
      id: 'actions',
      header: '',
      meta: { className: 'w-64 text-right' },
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => setPreviewFor({ id: row.original.companyId, name: row.original.companyName })}>
            <Eye /> Preview
          </Button>
          {can('billing.write') && (
            <Button size="sm" onClick={() => setDraftFor({ id: row.original.companyId, name: row.original.companyName })}>
              <FilePlus2 /> Create invoice draft
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2">
        <span className="text-xs text-muted">Period</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[13px]" aria-label="From" />
        <span className="text-muted">–</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-[13px]" aria-label="To" />
        <Button size="sm" variant="ghost" onClick={() => preset(now)}>
          This month
        </Button>
        <Button size="sm" variant="ghost" onClick={() => preset(subMonths(now, 1))}>
          Last month
        </Button>
        <Button size="sm" className="ml-auto" onClick={() => setPreviewFor('new')}>
          <Eye /> Billing preview
        </Button>
        {can('billing.write') && (
          <Button size="sm" variant="primary" onClick={() => setDraftFor('new')}>
            <Plus /> New invoice draft
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 border-b border-border bg-background px-5 py-3 md:grid-cols-5">
        <Stat label="Billable time" value={formatMinutes(sum('billableMinutes'))} hint="Approved, not covered" />
        <Stat label="Billable amount" value={money(sum('billableAmount'))} />
        <Stat label="Pending approval" value={formatMinutes(sum('pendingApprovalMinutes'))} tone={sum('pendingApprovalMinutes') ? 'warning' : undefined} hint="Not invoiceable until approved" onClick={() => navigate(`/time?userId=all&status=submitted,draft&from=${from}&to=${to}`)} />
        <Stat label="Contract covered" value={formatMinutes(sum('contractCoveredMinutes'))} hint="Included in contract fees" />
        <Stat label="Expenses" value={money(sum('expenseAmount'))} hint={`${sum('expenseCount')} unbilled`} />
      </div>
      <DataTable
        className="min-h-0 flex-1"
        columns={columns}
        data={rows}
        loading={review.isLoading}
        empty={
          <EmptyState
            icon={<Banknote />}
            title="Nothing to bill"
            description="No unbilled time or expenses in this period. Contract charges (recurring fees, fixed prices, blocks) can be checked with “Billing preview”."
          />
        }
      />
      <InvoiceDraftDialog
        open={!!draftFor}
        onOpenChange={(o) => {
          if (!o) {
            setDraftFor(null);
            setDraftPeriod(null);
          }
        }}
        company={draftFor === 'new' ? null : draftFor}
        periodStart={draftPeriod?.from ?? from}
        periodEnd={draftPeriod?.to ?? to}
        onCreated={(inv) => navigate(`/invoices/${inv.id}`)}
      />
      <BillingPreviewDialog
        open={!!previewFor}
        onOpenChange={(o) => !o && setPreviewFor(null)}
        company={previewFor === 'new' ? null : previewFor}
        periodStart={from}
        periodEnd={to}
        onCreateDraft={
          can('billing.write')
            ? (company, period) => {
                setPreviewFor(null);
                setDraftPeriod(period);
                setDraftFor(company);
              }
            : undefined
        }
      />
    </div>
  );
}

function ExpensesTab() {
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const money = useMoney();
  const t = useTableState({ filters: { unbilled: 'true' } });
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ExpenseRow | null>(null);
  const query = { ...t.query, unbilled: t.filters.unbilled === 'true' ? 'true' : undefined, tab: undefined };
  const list = useQuery({
    queryKey: ['expenses', query],
    queryFn: () => api.get<Paginated<ExpenseRow>>('/expenses', query),
    placeholderData: keepPreviousData,
  });
  const remove = useMutation({
    mutationFn: (e: ExpenseRow) => api.delete(`/expenses/${e.id}`),
    onSuccess: () => {
      toast.success('Expense deleted');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['billing-review'] });
    },
    onError: (e) => {
      setDeleting(null);
      handleFormError(e);
    },
  });
  const canWrite = can('billing.write') || can('time.write');
  const canDelete = (e: ExpenseRow) => !e.invoiceId && (can('billing.write') || (can('time.write') && e.userId === me?.user.id));

  const columns: Column<ExpenseRow>[] = [
    { header: 'Date', meta: { className: 'whitespace-nowrap' }, cell: ({ row }) => fmtDate(row.original.expenseDate) },
    {
      header: 'Company',
      cell: ({ row }) => (
        <Link to={`/companies/${row.original.companyId}`} className="hover:text-primary">
          {row.original.companyName}
        </Link>
      ),
    },
    { header: 'Description', cell: ({ row }) => <span className="font-medium">{row.original.description}</span> },
    {
      header: 'Ticket',
      cell: ({ row }) =>
        row.original.ticketId ? (
          <Link to={`/tickets/${row.original.ticketId}`} className="text-primary hover:underline">
            {row.original.ticketNumber}
          </Link>
        ) : (
          <span className="text-subtle">—</span>
        ),
    },
    { header: 'Billing code', cell: ({ row }) => row.original.billingCodeName ?? <span className="text-subtle">—</span> },
    { header: 'By', cell: ({ row }) => row.original.userName },
    { header: 'Amount', meta: { align: 'right' }, cell: ({ row }) => <span className="font-medium">{money(row.original.amount)}</span> },
    { header: 'Billable', cell: ({ row }) => (row.original.billable ? <Badge tone="success">Billable</Badge> : <Badge>Internal</Badge>) },
    {
      header: 'Invoice',
      cell: ({ row }) =>
        row.original.invoiceId ? (
          <Link to={`/invoices/${row.original.invoiceId}`} className="text-primary hover:underline">
            {row.original.invoiceNumber}
          </Link>
        ) : (
          <span className="text-subtle">Unbilled</span>
        ),
    },
    {
      id: 'actions',
      header: '',
      meta: { className: 'w-10' },
      cell: ({ row }) =>
        canDelete(row.original) && (
          <Button size="icon-sm" variant="ghost" aria-label="Delete expense" onClick={() => setDeleting(row.original)}>
            <Trash2 />
          </Button>
        ),
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-2">
        <SearchInput value={t.q} onChange={t.setQ} placeholder="Search description, company…" />
        <div className="w-56">
          <EntityPicker kind="company" value={t.filters.companyId ? Number(t.filters.companyId) : null} onChange={(id) => t.setFilter('companyId', id)} placeholder="All companies" />
        </div>
        <FilterSelect value={t.filters.unbilled === 'true' ? 'true' : ''} onChange={(v) => t.setFilter('unbilled', v || 'all')} placeholder="All expenses" options={[{ value: 'true', label: 'Unbilled only' }]} />
        {canWrite && (
          <Button size="sm" variant="primary" className="ml-auto" onClick={() => setAdding(true)}>
            <Plus /> Add expense
          </Button>
        )}
      </div>
      <DataTable
        className="min-h-0 flex-1"
        columns={columns}
        data={list.data?.data}
        total={list.data?.total}
        page={t.page}
        pageSize={t.pageSize}
        loading={list.isLoading}
        onPageChange={t.setPage}
        empty={<EmptyState icon={<Receipt />} title="No expenses" description="Record travel, materials and other costs to bill them to customers." />}
      />
      <ExpenseDialog open={adding} onOpenChange={setAdding} companyId={t.filters.companyId ? Number(t.filters.companyId) : null} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete expense?"
        description={deleting ? `${deleting.description} (${money(deleting.amount)}) will be deleted.` : undefined}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { FileSignature, Plus, Star } from 'lucide-react';
import { BILLING_PERIOD, CONTRACT_STATUS, CONTRACT_TYPE } from '@taskora/shared';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/utils';
import { useTableState } from '@/hooks/use-table-state';
import { DataTable, type Column } from '@/components/data-table';
import { FilterSelect, ListLayout, PageHeader, SearchInput } from '@/components/page';
import { EntityPicker } from '@/components/entity-picker';
import { Progress } from '@/components/charts';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/misc';
import { Tooltip } from '@/components/ui/overlays';
import { ContractStatusBadge, ContractTypeBadge, enumOpts, labelOf, useMoney } from '@/components/business/common';
import { ContractFormDialog } from '@/components/business/contract-form';

interface ContractRow {
  id: number;
  contractNumber: string;
  name: string;
  type: string;
  status: string;
  companyId: number;
  companyName: string;
  startDate: string;
  endDate: string | null;
  isDefault: boolean;
  slaName: string | null;
  recurringAmount: number | null;
  billingPeriod: string;
  usedMinutes: number;
  purchasedHours: number;
  remainingHours: number;
  lowBalance: boolean;
}

function daysUntil(date: string | null) {
  if (!date) return null;
  return Math.ceil((new Date(`${date}T23:59:59`).getTime() - Date.now()) / 86400_000);
}

export default function ContractsPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const money = useMoney();
  const t = useTableState({ sort: 'startDate', order: 'desc', filters: { status: 'active' } });
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['contracts', t.query],
    queryFn: () => api.get<Paginated<ContractRow>>('/contracts', { ...t.query, status: t.filters.status === 'all' ? undefined : t.filters.status }),
    placeholderData: keepPreviousData,
  });

  const columns: Column<ContractRow>[] = [
    {
      header: 'Contract',
      meta: { sortKey: 'name' },
      cell: ({ row: { original: c } }) => (
        <div className="min-w-0">
          <Link to={`/contracts/${c.id}`} className="font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>
            {c.name}
          </Link>
          <div className="flex items-center gap-1 text-xs text-muted">
            {c.contractNumber}
            {c.isDefault && (
              <Tooltip content="Default contract for new tickets">
                <Star className="size-3 fill-current text-warning" />
              </Tooltip>
            )}
          </div>
        </div>
      ),
    },
    { header: 'Type', meta: { sortKey: 'type' }, cell: ({ row }) => <ContractTypeBadge type={row.original.type} /> },
    {
      header: 'Company',
      meta: { sortKey: 'company' },
      cell: ({ row }) => (
        <Link to={`/companies/${row.original.companyId}`} className="hover:text-primary" onClick={(e) => e.stopPropagation()}>
          {row.original.companyName}
        </Link>
      ),
    },
    { header: 'Status', cell: ({ row }) => <ContractStatusBadge status={row.original.status} /> },
    { header: 'Start', meta: { sortKey: 'startDate', className: 'whitespace-nowrap' }, cell: ({ row }) => fmtDate(row.original.startDate) },
    {
      header: 'End',
      meta: { sortKey: 'endDate', className: 'whitespace-nowrap' },
      cell: ({ row }) => {
        const d = daysUntil(row.original.endDate);
        if (d === null) return <span className="text-subtle">Open-ended</span>;
        const soon = row.original.status === 'active' && d >= 0 && d <= 60;
        const past = d < 0 && row.original.status === 'active';
        return (
          <span className={past ? 'text-danger' : soon ? 'text-warning' : undefined}>
            {fmtDate(row.original.endDate)}
            {soon && <span className="ml-1 text-[11px]">({d}d)</span>}
          </span>
        );
      },
    },
    { header: 'SLA', cell: ({ row }) => row.original.slaName ?? <span className="text-subtle">Default</span> },
    {
      header: 'Usage',
      meta: { className: 'w-40' },
      cell: ({ row: { original: c } }) => {
        const used = c.usedMinutes / 60;
        if (c.purchasedHours > 0) {
          const pct = (used / c.purchasedHours) * 100;
          return (
            <div className="w-36">
              <div className="flex justify-between text-[11px] tabular-nums">
                <span>{used.toFixed(1)} h</span>
                <span className={c.lowBalance ? 'font-medium text-danger' : 'text-muted'} title={`${c.remainingHours} h remaining`}>
                  {c.lowBalance ? `${c.remainingHours} h left` : `/ ${c.purchasedHours} h`}
                </span>
              </div>
              <Progress value={pct} tone={c.lowBalance || pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'primary'} className="mt-0.5" />
            </div>
          );
        }
        return <span className="tabular-nums text-muted">{used.toFixed(1)} h logged</span>;
      },
    },
    {
      header: 'Recurring',
      meta: { align: 'right' },
      cell: ({ row: { original: c } }) =>
        c.recurringAmount ? (
          <span>
            {money(c.recurringAmount)}
            <span className="ml-1 text-[11px] text-muted">/{labelOf(BILLING_PERIOD, c.billingPeriod).toLowerCase()}</span>
          </span>
        ) : (
          <span className="text-subtle">—</span>
        ),
    },
  ];

  return (
    <ListLayout
      header={
        <PageHeader
          title="Contracts"
          subtitle="Service agreements, block hours, retainers and recurring services"
          icon={<FileSignature />}
          actions={
            can('contracts.write') && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus /> New contract
              </Button>
            )
          }
        />
      }
      toolbar={
        <>
          <SearchInput value={t.q} onChange={t.setQ} placeholder="Search name, number, company…" />
          <FilterSelect
            value={t.filters.status === 'all' ? '' : t.filters.status}
            onChange={(v) => t.setFilter('status', v || 'all')}
            placeholder="Any status"
            options={enumOpts(CONTRACT_STATUS)}
          />
          <FilterSelect value={t.filters.type} onChange={(v) => t.setFilter('type', v)} placeholder="All types" options={enumOpts(CONTRACT_TYPE)} />
          <div className="w-56">
            <EntityPicker kind="company" value={t.filters.companyId ? Number(t.filters.companyId) : null} onChange={(id) => t.setFilter('companyId', id)} placeholder="All companies" />
          </div>
          <FilterSelect value={t.filters.expiring} onChange={(v) => t.setFilter('expiring', v)} placeholder="Any end date" options={[{ value: 'true', label: 'Expiring within 60 days' }]} />
        </>
      }
    >
      <DataTable
        className="h-full"
        columns={columns}
        data={list.data?.data}
        total={list.data?.total}
        page={t.page}
        pageSize={t.pageSize}
        loading={list.isLoading}
        sort={t.sortState}
        onSortChange={t.setSort}
        onPageChange={t.setPage}
        onRowClick={(r) => navigate(`/contracts/${r.id}`)}
        empty={
          <EmptyState
            icon={<FileSignature />}
            title="No contracts found"
            description="Contracts define how work for a customer is billed and which SLA applies."
            action={
              can('contracts.write') && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus /> New contract
                </Button>
              )
            }
          />
        }
      />
      <ContractFormDialog open={creating} onOpenChange={setCreating} onSaved={(c) => navigate(`/contracts/${c.id}`)} />
    </ListLayout>
  );
}

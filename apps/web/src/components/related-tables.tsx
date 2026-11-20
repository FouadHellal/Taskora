import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CONTRACT_STATUS, CONTRACT_TYPE, PROJECT_STATUS } from '@taskora/shared';
import { api, type Paginated } from '@/lib/api';
import { fmtDate, fmtRelative } from '@/lib/utils';
import { DataTable, type Column } from './data-table';
import { DeviceStateBadge, LifecycleBadge } from './badges';
import { Badge } from './ui/misc';
import { Progress } from './charts';
import { ticketColumns, type TicketRow } from '@/pages/tickets/list';
import { useState } from 'react';
import { useOpenTicket } from '@/lib/open-ticket';

/** Embedded ticket list filtered by e.g. companyId / contactId / configurationItemId. */
export function RelatedTickets({ filter, scope = 'open' }: { filter: Record<string, string | number>; scope?: 'open' | 'all' }) {
  const navigate = useNavigate();
  const openTicket = useOpenTicket();
  const [page, setPage] = useState(1);
  const [state, setState] = useState(scope);
  const q = useQuery({
    queryKey: ['tickets', 'related', filter, state, page],
    queryFn: () => api.get<Paginated<TicketRow>>('/tickets', { ...filter, statusCategory: state === 'open' ? 'open' : 'all', page, pageSize: 25, sort: 'lastActivityAt', order: 'desc' }),
  });
  return (
    <div>
      <div className="flex gap-1 border-b border-border px-3 py-1.5">
        {(['open', 'all'] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              setState(s);
              setPage(1);
            }}
            className={`cursor-pointer rounded px-2 py-1 text-xs ${state === s ? 'bg-surface-2 font-medium' : 'text-muted hover:text-foreground'}`}
          >
            {s === 'open' ? 'Open' : 'All tickets'}
          </button>
        ))}
      </div>
      <DataTable
        columns={ticketColumns.filter((c) => c.header !== 'Company' || !('companyId' in filter))}
        data={q.data?.data}
        total={q.data?.total}
        page={page}
        pageSize={25}
        loading={q.isLoading}
        onPageChange={setPage}
        onRowClick={(r, e) => openTicket(r.id, e)}
      />
    </div>
  );
}

export interface CiRow {
  id: number;
  ciNumber: string;
  name: string;
  ciTypeName: string;
  companyId: number;
  companyName: string;
  contactId: number | null;
  contactName: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  hostname: string | null;
  osName: string | null;
  ipAddress: string | null;
  lifecycleStatus: string;
  warrantyExpiresAt: string | null;
  lastSeenAt: string | null;
  source: string;
  agentStatus: string | null;
  rebootRequired: boolean | null;
  missingCriticalUpdates: number | null;
  openTickets: number;
}

export const ciColumns: Column<CiRow>[] = [
  {
    header: 'Name',
    meta: { sortKey: 'name' },
    cell: ({ row }) => (
      <div>
        <Link to={`/assets/${row.original.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-primary">
          {row.original.name}
        </Link>
        <div className="text-[11px] text-muted">{row.original.ciNumber}</div>
      </div>
    ),
  },
  { header: 'Type', meta: { sortKey: 'type' }, cell: ({ row }) => row.original.ciTypeName },
  {
    header: 'Company',
    meta: { sortKey: 'company' },
    cell: ({ row }) => (
      <Link to={`/companies/${row.original.companyId}`} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
        {row.original.companyName}
      </Link>
    ),
  },
  {
    header: 'Assigned to',
    cell: ({ row }) =>
      row.original.contactId ? (
        <Link to={`/contacts/${row.original.contactId}`} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
          {row.original.contactName}
        </Link>
      ) : (
        <span className="text-subtle">—</span>
      ),
  },
  { header: 'Model', cell: ({ row }) => <span className="text-muted">{[row.original.manufacturer, row.original.model].filter(Boolean).join(' ') || '—'}</span> },
  { header: 'Serial', cell: ({ row }) => <span className="font-mono text-[12px]">{row.original.serialNumber ?? '—'}</span> },
  { header: 'OS', cell: ({ row }) => <span className="text-muted">{row.original.osName ?? '—'}</span> },
  {
    header: 'Health',
    cell: ({ row }) => (
      <div className="flex gap-1">
        <DeviceStateBadge agentStatus={row.original.agentStatus} />
        {row.original.rebootRequired && <Badge tone="warning">Reboot</Badge>}
        {!!row.original.missingCriticalUpdates && <Badge tone="danger">{row.original.missingCriticalUpdates} crit.</Badge>}
      </div>
    ),
  },
  {
    header: 'Warranty',
    meta: { sortKey: 'warrantyExpiresAt' },
    cell: ({ row }) => {
      const w = row.original.warrantyExpiresAt;
      if (!w) return <span className="text-subtle">—</span>;
      const expired = new Date(w) < new Date();
      return <span className={expired ? 'text-danger' : new Date(w).getTime() - Date.now() < 60 * 86400_000 ? 'text-warning' : ''}>{fmtDate(w)}</span>;
    },
  },
  { header: 'Lifecycle', meta: { sortKey: 'lifecycleStatus' }, cell: ({ row }) => <LifecycleBadge status={row.original.lifecycleStatus} /> },
  { header: 'Open tickets', meta: { align: 'right' }, cell: ({ row }) => row.original.openTickets || <span className="text-subtle">0</span> },
];

export function RelatedCis({ filter, hide = [] }: { filter: Record<string, string | number>; hide?: string[] }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['cis', 'related', filter, page],
    queryFn: () => api.get<Paginated<CiRow>>('/configuration-items', { ...filter, page, pageSize: 50 }),
  });
  return (
    <DataTable
      columns={ciColumns.filter((c) => !hide.includes(String(c.header)))}
      data={q.data?.data}
      total={q.data?.total}
      page={page}
      pageSize={50}
      loading={q.isLoading}
      onPageChange={setPage}
      onRowClick={(r) => navigate(`/assets/${r.id}`)}
    />
  );
}

interface ContractRow {
  id: number;
  contractNumber: string;
  name: string;
  type: string;
  status: string;
  startDate: string;
  endDate: string | null;
  isDefault: boolean;
  slaName: string | null;
  usedMinutes: number;
  purchasedHours: number;
}

export function RelatedContracts({ companyId }: { companyId: number }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['contracts', 'company-all', companyId], queryFn: () => api.get<Paginated<ContractRow>>('/contracts', { companyId, pageSize: 100 }) });
  const cols: Column<ContractRow>[] = [
    {
      header: 'Contract',
      cell: ({ row }) => (
        <div>
          <span className="font-medium">{row.original.name}</span> {row.original.isDefault && <Badge tone="primary">Default</Badge>}
          <div className="text-[11px] text-muted">{row.original.contractNumber}</div>
        </div>
      ),
    },
    { header: 'Type', cell: ({ row }) => CONTRACT_TYPE.labels[row.original.type as keyof typeof CONTRACT_TYPE.labels] ?? row.original.type },
    {
      header: 'Status',
      cell: ({ row }) => <Badge tone={row.original.status === 'active' ? 'success' : 'neutral'}>{CONTRACT_STATUS.labels[row.original.status as keyof typeof CONTRACT_STATUS.labels] ?? row.original.status}</Badge>,
    },
    { header: 'Period', cell: ({ row }) => `${fmtDate(row.original.startDate)} – ${row.original.endDate ? fmtDate(row.original.endDate) : 'open-ended'}` },
    { header: 'SLA', cell: ({ row }) => row.original.slaName ?? '—' },
    {
      header: 'Usage',
      cell: ({ row }) =>
        row.original.purchasedHours > 0 ? (
          <div className="w-36">
            <div className="text-[11px] text-muted">
              {(row.original.usedMinutes / 60).toFixed(1)} / {row.original.purchasedHours} h
            </div>
            <Progress value={(row.original.usedMinutes / 60 / row.original.purchasedHours) * 100} tone={row.original.usedMinutes / 60 > row.original.purchasedHours ? 'danger' : 'primary'} />
          </div>
        ) : (
          `${(row.original.usedMinutes / 60).toFixed(1)} h logged`
        ),
    },
  ];
  return <DataTable columns={cols} data={q.data?.data} loading={q.isLoading} onRowClick={(r) => navigate(`/contracts/${r.id}`)} />;
}

interface ProjectRow {
  id: number;
  projectNumber: string;
  name: string;
  status: string;
  managerName: string | null;
  endDate: string | null;
  progress: number;
  actualMinutes: number;
  estimatedHours: number | null;
}

export function RelatedProjects({ companyId }: { companyId: number }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['projects', 'company', companyId], queryFn: () => api.get<Paginated<ProjectRow>>('/projects', { companyId, pageSize: 100 }) });
  const cols: Column<ProjectRow>[] = [
    { header: 'Project', cell: ({ row }) => <div><span className="font-medium">{row.original.name}</span><div className="text-[11px] text-muted">{row.original.projectNumber}</div></div> },
    { header: 'Status', cell: ({ row }) => <Badge>{PROJECT_STATUS.labels[row.original.status as keyof typeof PROJECT_STATUS.labels] ?? row.original.status}</Badge> },
    { header: 'Manager', cell: ({ row }) => row.original.managerName ?? '—' },
    { header: 'Due', cell: ({ row }) => fmtDate(row.original.endDate) },
    {
      header: 'Progress',
      cell: ({ row }) => (
        <div className="w-32">
          <div className="text-[11px] text-muted">{row.original.progress}%</div>
          <Progress value={row.original.progress} tone="success" />
        </div>
      ),
    },
    { header: 'Hours', meta: { align: 'right' }, cell: ({ row }) => `${(row.original.actualMinutes / 60).toFixed(1)}${row.original.estimatedHours ? ` / ${row.original.estimatedHours}` : ''}` },
  ];
  return <DataTable columns={cols} data={q.data?.data} loading={q.isLoading} onRowClick={(r) => navigate(`/projects/${r.id}`)} />;
}

export { fmtRelative };

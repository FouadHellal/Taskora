import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Clock, Ticket } from 'lucide-react';
import { formatMinutes } from '@taskora/shared';
import { api, type Paginated } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/utils';
import { DataTable, type Column, type Sort } from '../data-table';
import { PriorityBadge, StatusBadge } from '../badges';
import { Badge, EmptyState } from '../ui/misc';
import { FilterSelect } from '../page';
import { TimeStatusBadge, useMoney } from './common';
import { TicketLink, useOpenTicket } from '@/lib/open-ticket';

export interface TicketRow {
  id: number;
  ticketNumber: string;
  title: string;
  companyId: number;
  companyName: string;
  statusName: string;
  statusColor: string;
  statusCategory: string;
  priorityName: string;
  priorityColor: string;
  priorityLevel: number;
  assigneeName: string | null;
  createdAt: string;
  minutesWorked: number;
}

/** Tickets linked to a record (contract, project…), with open/all toggle. */
export function RelatedTickets({ filter, pageSize = 25 }: { filter: Record<string, number>; pageSize?: number }) {
  const navigate = useNavigate();
  const openTicket = useOpenTicket();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>({ sort: 'createdAt', order: 'desc' });
  const [cat, setCat] = useState('');
  const list = useQuery({
    queryKey: ['tickets', 'related', filter, page, sort, cat],
    queryFn: () => api.get<Paginated<TicketRow>>('/tickets', { ...filter, page, pageSize, sort: sort.sort, order: sort.order, statusCategory: cat || undefined }),
    placeholderData: keepPreviousData,
  });
  const columns: Column<TicketRow>[] = [
    {
      header: 'Ticket',
      meta: { sortKey: 'ticketNumber' },
      cell: ({ row: { original: t } }) => (
        <div className="min-w-0 max-w-md">
          <TicketLink ticketId={t.id} className="font-medium hover:text-primary" onClick={(e) => e.stopPropagation()}>
            <span className="mr-1.5 text-muted">{t.ticketNumber}</span>
            {t.title}
          </TicketLink>
        </div>
      ),
    },
    { header: 'Status', meta: { sortKey: 'status' }, cell: ({ row }) => <StatusBadge name={row.original.statusName} color={row.original.statusColor} /> },
    { header: 'Priority', meta: { sortKey: 'priority' }, cell: ({ row }) => <PriorityBadge name={row.original.priorityName} color={row.original.priorityColor} level={row.original.priorityLevel} /> },
    { header: 'Assignee', cell: ({ row }) => row.original.assigneeName ?? <span className="text-subtle">Unassigned</span> },
    { header: 'Worked', meta: { align: 'right' }, cell: ({ row }) => formatMinutes(row.original.minutesWorked) },
    { header: 'Created', meta: { sortKey: 'createdAt', className: 'whitespace-nowrap' }, cell: ({ row }) => fmtDate(row.original.createdAt) },
  ];
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <FilterSelect
          value={cat}
          onChange={(v) => {
            setCat(v);
            setPage(1);
          }}
          placeholder="All tickets"
          options={[
            { value: 'open', label: 'Open tickets' },
            { value: 'done', label: 'Resolved / closed' },
          ]}
        />
        <span className="text-xs text-muted">{list.data ? `${list.data.total} tickets` : ''}</span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <DataTable
          columns={columns}
          data={list.data?.data}
          total={list.data?.total}
          page={page}
          pageSize={pageSize}
          loading={list.isLoading}
          sort={sort}
          onSortChange={(s) => {
            setSort(s);
            setPage(1);
          }}
          onPageChange={setPage}
          onRowClick={(r, e) => openTicket(r.id, e)}
          empty={<EmptyState icon={<Ticket />} title="No tickets" description="No tickets are linked to this record yet." />}
        />
      </div>
    </div>
  );
}

export interface TimeEntryRow {
  id: number;
  userId: number;
  userName: string;
  ticketId: number | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
  projectTaskId: number | null;
  taskTitle: string | null;
  projectId: number | null;
  projectName: string | null;
  companyId: number;
  companyName: string;
  contractId: number | null;
  contractName: string | null;
  workTypeId: number | null;
  workTypeName: string | null;
  startedAt: string;
  durationMinutes: number;
  billable: boolean;
  contractCovered: boolean;
  hourlyRate: number | null;
  description: string;
  internalNotes: string | null;
  status: string;
  invoiceId: number | null;
}

export interface TimeList extends Paginated<TimeEntryRow> {
  totals: { minutes: number; billableMinutes: number; coveredMinutes: number };
}

/** Read-only time entries of a record (contract or project) with totals. */
export function RelatedTime({ filter, pageSize = 25 }: { filter: Record<string, number>; pageSize?: number }) {
  const money = useMoney();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['time-entries', 'related', filter, page],
    queryFn: () => api.get<TimeList>('/time-entries', { ...filter, page, pageSize }),
    placeholderData: keepPreviousData,
  });
  const totals = list.data?.totals;
  const columns: Column<TimeEntryRow>[] = [
    { header: 'Date', meta: { className: 'whitespace-nowrap' }, cell: ({ row }) => fmtDateTime(row.original.startedAt) },
    { header: 'Resource', cell: ({ row }) => row.original.userName },
    {
      header: 'Work item',
      cell: ({ row: { original: e } }) =>
        e.ticketId ? (
          <TicketLink ticketId={e.ticketId} className="hover:text-primary">
            <span className="text-muted">{e.ticketNumber}</span> {e.ticketTitle}
          </TicketLink>
        ) : e.projectId ? (
          <Link to={`/projects/${e.projectId}`} className="hover:text-primary">
            {e.taskTitle} <span className="text-muted">· {e.projectName}</span>
          </Link>
        ) : (
          '—'
        ),
    },
    { header: 'Work type', cell: ({ row }) => row.original.workTypeName ?? <span className="text-subtle">—</span> },
    { header: 'Description', meta: { className: 'max-w-xs' }, cell: ({ row }) => <span className="line-clamp-1 text-muted">{row.original.description}</span> },
    { header: 'Duration', meta: { align: 'right' }, cell: ({ row }) => formatMinutes(row.original.durationMinutes) },
    {
      header: 'Billing',
      cell: ({ row: { original: e } }) =>
        e.contractCovered ? <Badge tone="info">Covered</Badge> : e.billable ? <Badge tone="success">{e.hourlyRate != null ? money(e.hourlyRate) + '/h' : 'Billable'}</Badge> : <Badge>Non-billable</Badge>,
    },
    { header: 'Status', cell: ({ row }) => <TimeStatusBadge status={row.original.status} /> },
  ];
  return (
    <div>
      {totals && (
        <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted">
          <span>
            Total <b className="text-foreground">{formatMinutes(totals.minutes)}</b>
          </span>
          <span>
            Billable <b className="text-foreground">{formatMinutes(totals.billableMinutes)}</b>
          </span>
          <span>
            Contract covered <b className="text-foreground">{formatMinutes(totals.coveredMinutes)}</b>
          </span>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border">
        <DataTable
          columns={columns}
          data={list.data?.data}
          total={list.data?.total}
          page={page}
          pageSize={pageSize}
          loading={list.isLoading}
          onPageChange={setPage}
          empty={<EmptyState icon={<Clock />} title="No time logged" description="Time entries logged against this record appear here." />}
        />
      </div>
    </div>
  );
}

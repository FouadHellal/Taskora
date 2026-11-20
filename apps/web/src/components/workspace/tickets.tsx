import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { handleFormError } from '@/components/form';
import type { Column } from '@/components/data-table';
import { PriorityBadge, SlaBadge, StatusBadge, type SlaState } from '@/components/badges';
import { Avatar } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/overlays';
import { TicketLink } from '@/lib/open-ticket';

/** Row shape returned by GET /tickets. */
export interface TicketRow {
  id: number;
  ticketNumber: string;
  title: string;
  companyId: number;
  companyName: string;
  contactId: number | null;
  contactName: string | null;
  assignedUserId: number | null;
  assigneeName: string | null;
  queueId: number | null;
  queueName: string | null;
  statusId: number;
  statusName: string;
  statusColor: string;
  statusCategory: string;
  priorityId: number;
  priorityName: string;
  priorityColor: string;
  priorityLevel: number;
  dueAt: string | null;
  firstResponseDueAt: string | null;
  firstResponseAt: string | null;
  resolutionDueAt: string | null;
  resolvedAt: string | null;
  slaPausedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  minutesWorked: number;
  sla: { firstResponse: SlaState; resolution: SlaState; overall: SlaState };
}

export const stop = (e: React.MouseEvent) => e.stopPropagation();

/** Reusable column definitions for ticket tables. */
export const ticketCols = {
  ticket: {
    header: 'Ticket',
    meta: { sortKey: 'ticketNumber' },
    cell: ({ row }) => (
      <div className="min-w-0 max-w-[28rem]">
        <TicketLink ticketId={row.original.id} onClick={stop} className="block truncate font-medium hover:text-primary">
          <span className="mr-1.5 font-mono text-xs text-muted">{row.original.ticketNumber}</span>
          {row.original.title}
        </TicketLink>
      </div>
    ),
  } as Column<TicketRow>,
  company: {
    header: 'Company',
    meta: { sortKey: 'company' },
    cell: ({ row }) => (
      <Link to={`/companies/${row.original.companyId}`} onClick={stop} className="truncate hover:text-primary">
        {row.original.companyName}
      </Link>
    ),
  } as Column<TicketRow>,
  status: {
    header: 'Status',
    meta: { sortKey: 'status' },
    cell: ({ row }) => <StatusBadge name={row.original.statusName} color={row.original.statusColor} />,
  } as Column<TicketRow>,
  priority: {
    header: 'Priority',
    meta: { sortKey: 'priority' },
    cell: ({ row }) => <PriorityBadge name={row.original.priorityName} color={row.original.priorityColor} level={row.original.priorityLevel} />,
  } as Column<TicketRow>,
  assignee: {
    header: 'Assignee',
    meta: { sortKey: 'assignee' },
    cell: ({ row }) =>
      row.original.assigneeName ? (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Avatar name={row.original.assigneeName} className="size-5 text-[9px]" />
          {row.original.assigneeName}
        </span>
      ) : (
        <span className="text-subtle">Unassigned</span>
      ),
  } as Column<TicketRow>,
  queue: {
    header: 'Queue',
    meta: { sortKey: 'queue' },
    cell: ({ row }) => <span className="whitespace-nowrap text-muted">{row.original.queueName ?? '—'}</span>,
  } as Column<TicketRow>,
  sla: {
    header: 'SLA',
    meta: { sortKey: 'dueAt' },
    cell: ({ row }) => {
      const t = row.original;
      const due = t.sla.overall === 'breached' || t.sla.overall === 'at_risk' ? (t.sla.firstResponse === t.sla.overall && !t.firstResponseAt ? t.firstResponseDueAt : t.resolutionDueAt) : t.resolutionDueAt;
      return <SlaBadge state={t.sla.overall} due={due} />;
    },
  } as Column<TicketRow>,
  due: {
    header: 'Due',
    meta: { sortKey: 'dueAt' },
    cell: ({ row }) => {
      const d = row.original.dueAt ?? row.original.resolutionDueAt;
      if (!d) return <span className="text-subtle">—</span>;
      const late = new Date(d) < new Date();
      return (
        <Tooltip content={fmtDateTime(d)}>
          <span className={late ? 'whitespace-nowrap font-medium text-danger' : 'whitespace-nowrap text-muted'}>{fmtRelative(d)}</span>
        </Tooltip>
      );
    },
  } as Column<TicketRow>,
  age: {
    header: 'Age',
    meta: { sortKey: 'createdAt' },
    cell: ({ row }) => (
      <Tooltip content={`Created ${fmtDateTime(row.original.createdAt)}`}>
        <span className="whitespace-nowrap text-muted">{fmtRelative(row.original.createdAt).replace(' ago', '')}</span>
      </Tooltip>
    ),
  } as Column<TicketRow>,
};

/** "Assign to me" quick action for a ticket row (only rendered with tickets.write). */
export function AssignToMeButton({ ticket, invalidate = ['tickets'] }: { ticket: TicketRow; invalidate?: string[] }) {
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const assign = useMutation({
    mutationFn: () => api.patch(`/tickets/${ticket.id}`, { assignedUserId: me!.user.id }),
    onSuccess: () => {
      toast.success(`${ticket.ticketNumber} assigned to you`);
      for (const k of invalidate) qc.invalidateQueries({ queryKey: [k] });
    },
    onError: (e) => handleFormError(e),
  });
  if (!me || !can('tickets.write') || ticket.assignedUserId === me.user.id) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={assign.isPending}
      onClick={(e) => {
        e.stopPropagation();
        assign.mutate();
      }}
      className="opacity-70 group-hover:opacity-100"
    >
      <UserPlus /> Take
    </Button>
  );
}

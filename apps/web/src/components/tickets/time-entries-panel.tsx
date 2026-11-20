import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatMinutes } from '@taskora/shared';
import { api } from '@/lib/api';
import { useAuth, useMe } from '@/lib/auth';
import { fmtDateTime } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/misc';
import { ConfirmDialog } from '../ui/overlays';
import { handleFormError } from '../form';
import { LogTimeDialog } from './log-time-dialog';
import { NoteBody } from './note-body';
import type { TicketTimeEntry, TimelineItem } from './ticket-types';

type TimeItem = Extract<TimelineItem, { kind: 'time' }>;

const STATUS_TONE: Record<string, 'neutral' | 'warning' | 'success' | 'info' | 'danger'> = { submitted: 'warning', approved: 'success', billed: 'info', rejected: 'danger', draft: 'neutral' };

/** The ticket's time entries as a table with totals, editing and deletion. */
export function TimeEntriesPanel({ ticketId, items, onNew }: { ticketId: number; items: TimelineItem[]; onNew?: () => void }) {
  const { can } = useAuth();
  const me = useMe();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<TicketTimeEntry | null>(null);
  const [deleting, setDeleting] = useState<TicketTimeEntry | null>(null);
  const rows = items.filter((i): i is TimeItem => i.kind === 'time');
  const total = rows.reduce((n, r) => n + r.entry.durationMinutes, 0);
  const billable = rows.reduce((n, r) => n + (r.entry.billable && !r.entry.contractCovered ? r.entry.durationMinutes : 0), 0);
  const covered = rows.reduce((n, r) => n + (r.entry.contractCovered ? r.entry.durationMinutes : 0), 0);
  const mayChange = (e: TicketTimeEntry) => can('time.write') && e.status !== 'billed' && (e.userId === me.user.id || can('time.write_all'));

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/time-entries/${id}`),
    onSuccess: () => {
      toast.success('Time entry deleted');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['timeline', ticketId] });
      qc.invalidateQueries({ queryKey: ['ticket', ticketId] });
      qc.invalidateQueries({ queryKey: ['time-entries'] });
    },
    onError: (e) => handleFormError(e),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>
            Total <b className="text-foreground">{formatMinutes(total)}</b>
          </span>
          <span>
            Billable <b className="text-foreground">{formatMinutes(billable)}</b>
          </span>
          <span>
            Contract <b className="text-foreground">{formatMinutes(covered)}</b>
          </span>
        </div>
        {onNew && can('time.write') && (
          <Button size="sm" variant="primary" className="ml-auto" onClick={onNew}>
            <Plus /> New time entry
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-muted">
          <Clock className="mx-auto mb-2 size-5 text-subtle" />
          No time logged on this ticket yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border scrollbar-thin">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left text-[11px] font-medium uppercase tracking-wide text-subtle">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Resource</th>
                <th className="px-3 py-2 font-medium">Work type</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Billing</th>
                <th className="px-3 py-2 font-medium">Summary</th>
                <th className="w-16 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ entry, userName }) => (
                <tr key={entry.id} className="group align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{fmtDateTime(entry.startedAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{userName ?? '—'}</td>
                  <td className="px-3 py-2 text-muted">{entry.workTypeName ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{formatMinutes(entry.durationMinutes)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {entry.contractCovered ? <Badge>Contract</Badge> : entry.billable ? <Badge tone="success">Billable</Badge> : <Badge>Non-billable</Badge>}
                      {entry.status !== 'approved' && <Badge tone={STATUS_TONE[entry.status] ?? 'neutral'}>{entry.status}</Badge>}
                    </div>
                  </td>
                  <td className="min-w-64 px-3 py-2">
                    <NoteBody text={entry.description} thumbs />
                    {entry.internalNotes && <NoteBody text={entry.internalNotes} thumbs className="mt-1 border-l-2 border-border pl-2 text-xs text-muted" />}
                  </td>
                  <td className="px-2 py-1.5">
                    {mayChange(entry) && (
                      <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                        <Button size="icon-sm" variant="ghost" onClick={() => setEditing(entry)} aria-label="Edit time entry">
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => setDeleting(entry)} aria-label="Delete time entry">
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-surface-2 text-xs font-medium">
                <td className="px-3 py-2" colSpan={3}>
                  {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMinutes(total)}</td>
                <td className="px-3 py-2 text-muted" colSpan={3}>
                  {formatMinutes(billable)} billable · {formatMinutes(covered)} on contract
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <LogTimeDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} ticketId={ticketId} entry={editing} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this time entry?"
        description={deleting ? `${formatMinutes(deleting.durationMinutes)} logged on ${fmtDateTime(deleting.startedAt)} will be removed.` : undefined}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

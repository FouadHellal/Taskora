import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Clock, Eye, EyeOff, FileText, GitBranch, Lock, Mail, Paperclip, Pencil, Plus, Sparkles, Trash2, UserCheck, Workflow } from 'lucide-react';
import { toast } from 'sonner';
import { formatMinutes } from '@taskora/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { cn, fmtDateTime, fmtRelative } from '@/lib/utils';
import { Avatar, Badge } from '../ui/misc';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/overlays';
import type { TimelineItem } from './ticket-types';
import { NoteBody } from './note-body';
import { ImageTextarea } from './image-paste';

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  priorityId: 'priority',
  queueId: 'queue',
  contactId: 'contact',
  configurationItemId: 'configuration item',
  ticketTypeId: 'ticket type',
  issueTypeId: 'issue type',
  subIssueTypeId: 'sub-issue type',
  sourceId: 'source',
  slaId: 'SLA',
  contractId: 'contract',
  dueAt: 'due date',
  estimatedHours: 'estimated hours',
  resolution: 'resolution',
  tags: 'tags',
  description: 'description',
  customFields: 'custom fields',
  companyId: 'company',
  locationId: 'location',
  projectId: 'project',
};

function describeEvent(type: string, d: Record<string, unknown>): { icon: typeof Clock; text: React.ReactNode } {
  switch (type) {
    case 'created':
      return { icon: Plus, text: d.automation ? 'created the ticket (automation)' : 'created the ticket' };
    case 'status_changed':
    case 'resolved':
      return {
        icon: ArrowRightLeft,
        text: (
          <>
            changed status from <b>{String(d.from)}</b> to <b>{String(d.to)}</b>
          </>
        ),
      };
    case 'reopened':
      return { icon: ArrowRightLeft, text: <>reopened the ticket</> };
    case 'assigned':
      return { icon: UserCheck, text: d.toLabel ? <>assigned the ticket to <b>{String(d.toLabel)}</b></> : <>unassigned the ticket</> };
    case 'field_changed': {
      const field = FIELD_LABELS[String(d.field)] ?? String(d.field);
      if (d.fromLabel !== undefined || d.toLabel !== undefined) {
        return { icon: Pencil, text: <>changed {field}{d.fromLabel ? <> from <b>{String(d.fromLabel)}</b></> : null} to <b>{String(d.toLabel ?? 'none')}</b></> };
      }
      if (d.field === 'tags') return { icon: Pencil, text: <>updated tags</> };
      if (d.field === 'dueAt') return { icon: Pencil, text: <>changed the due date{d.to ? <> to <b>{fmtDateTime(String(d.to))}</b></> : <> (cleared)</>}</> };
      if (typeof d.to === 'string' || typeof d.to === 'number') return { icon: Pencil, text: <>changed {field} to <b>{String(d.to).slice(0, 80)}</b></> };
      return { icon: Pencil, text: <>updated the {field}</> };
    }
    case 'time_added':
      return { icon: Clock, text: <>logged {formatMinutes(Number(d.minutes))}</> };
    case 'attachment_added':
      return { icon: Paperclip, text: <>attached <b>{String(d.fileName)}</b></> };
    case 'relation_added':
      return { icon: GitBranch, text: <>linked a related ticket</> };
    case 'sla_breached':
      return { icon: Clock, text: <span className="text-danger">SLA {String(d.target).replace('_', ' ')} target breached</span> };
    case 'sla_warning':
      return { icon: Clock, text: <span className="text-warning">SLA {String(d.target).replace('_', ' ')} target at risk</span> };
    case 'email_sent':
      if (d.subject)
        return {
          icon: Mail,
          text: (
            <>
              sent an e-mail to <b>{([] as unknown[]).concat(d.to ?? []).join(', ')}</b>
              {(d.cc as string[] | undefined)?.length ? <> (cc {(d.cc as string[]).join(', ')})</> : null}
            </>
          ),
        };
      return { icon: Mail, text: <>e-mailed the note to <b>{String(d.to)}</b></> };
    case 'workflow':
      return { icon: Workflow, text: <>workflow rule <b>{String(d.rule)}</b> ran: {(d.results as string[] | undefined)?.join(', ')}</> };
    default:
      return { icon: Sparkles, text: type.replace(/_/g, ' ') };
  }
}

export function Timeline({ ticketId, items, filter }: { ticketId: number; items: TimelineItem[]; filter: 'all' | 'notes' | 'public' | 'history' | 'time' }) {
  const visible = items.filter((i) => {
    if (filter === 'notes') return i.kind === 'note';
    if (filter === 'public') return i.kind === 'note' && i.note.visibility === 'public';
    if (filter === 'history') return i.kind === 'event';
    if (filter === 'time') return i.kind === 'time';
    return true;
  });
  if (!visible.length) return <p className="py-8 text-center text-xs text-muted">Nothing here yet.</p>;
  return (
    <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-border">
      {visible.map((item) => (
        <li key={item.id} className="relative pl-8">
          {item.kind === 'note' ? (
            <NoteItem ticketId={ticketId} item={item} />
          ) : item.kind === 'event' ? (
            <EventItem item={item} />
          ) : item.kind === 'time' ? (
            <div className="flex items-start gap-2 text-[12px]">
              <span className="absolute left-0 flex size-6 items-center justify-center rounded-full border border-border bg-surface text-info">
                <Clock className="size-3" />
              </span>
              <div className="min-w-0 flex-1 rounded-md border border-border bg-info-soft/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.userName}</span>
                  <span className="text-muted">logged</span>
                  <Badge tone="info">{formatMinutes(item.entry.durationMinutes)}</Badge>
                  {item.entry.workTypeName && <span className="text-muted">{item.entry.workTypeName}</span>}
                  {item.entry.contractCovered ? <Badge>Contract</Badge> : item.entry.billable ? <Badge tone="success">Billable</Badge> : <Badge>Non-billable</Badge>}
                  <span className="ml-auto text-[11px] text-subtle" title={fmtDateTime(item.at)}>
                    {fmtRelative(item.at)}
                  </span>
                </div>
                <NoteBody text={item.entry.description} className="mt-1 text-[13px]" />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[12px] text-muted">
              <span className="absolute left-0 flex size-6 items-center justify-center rounded-full border border-border bg-surface">
                <Paperclip className="size-3" />
              </span>
              <span className="font-medium text-foreground">{item.userName}</span> attached
              <a href={`/api/v1/attachments/file/${item.file.id}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                <FileText className="size-3" /> {item.file.fileName}
              </a>
              <span className="ml-auto text-[11px] text-subtle">{fmtRelative(item.at)}</span>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

type NoteTimelineItem = Extract<TimelineItem, { kind: 'note' }>;

/** Notes only, newest first (the timeline is already sorted that way). */
export function NotesList({ ticketId, items, visibility = 'all' }: { ticketId: number; items: TimelineItem[]; visibility?: 'all' | 'internal' | 'public' }) {
  const notes = items.filter((i): i is NoteTimelineItem => i.kind === 'note' && (visibility === 'all' || i.note.visibility === visibility));
  if (!notes.length) return <p className="py-8 text-center text-xs text-muted">No notes yet.</p>;
  return (
    <ol className="space-y-3">
      {notes.map((item) => (
        <li key={item.id} className="relative pl-8">
          <NoteItem ticketId={ticketId} item={item} />
        </li>
      ))}
    </ol>
  );
}

function EventItem({ item }: { item: Extract<TimelineItem, { kind: 'event' }> }) {
  const { icon: Icon, text } = describeEvent(item.event.type, item.event.data);
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12px] text-muted">
      <span className="absolute left-0 flex size-6 items-center justify-center rounded-full border border-border bg-surface">
        <Icon className="size-3" />
      </span>
      <span>
        <span className="font-medium text-foreground">{item.userName ?? 'System'}</span> {text}
      </span>
      <Tooltip content={fmtDateTime(item.at)}>
        <span className="ml-auto shrink-0 text-[11px] text-subtle">{fmtRelative(item.at)}</span>
      </Tooltip>
    </div>
  );
}

function NoteItem({ ticketId, item }: { ticketId: number; item: Extract<TimelineItem, { kind: 'note' }> }) {
  const me = useMe();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.note.body);
  const [busy, setBusy] = useState(false);
  const isPublic = item.note.visibility === 'public';
  const canEdit = item.note.userId === me.user.id;
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/tickets/${ticketId}/notes/${item.note.id}`, patch),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['timeline', ticketId] });
    },
    onError: () => toast.error('Could not update the note'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/tickets/${ticketId}/notes/${item.note.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['timeline', ticketId] }),
  });
  return (
    <div className="group">
      <span className="absolute left-0 top-1">
        <Avatar name={item.userName ?? 'System'} />
      </span>
      <div className={cn('rounded-md border px-3 py-2', isPublic ? 'border-primary/30 bg-primary-soft/30' : 'border-border bg-surface', item.note.kind === 'automation' && 'border-dashed')}>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="font-medium">{item.userName ?? 'Automation'}</span>
          {isPublic ? (
            <Badge tone="primary">
              <Eye className="size-3" /> Customer-visible
            </Badge>
          ) : (
            <Badge>
              <Lock className="size-3" /> Internal
            </Badge>
          )}
          {item.note.kind === 'email_out' && (
            <Badge tone="info">
              <Mail className="size-3" /> E-mail sent
            </Badge>
          )}
          <Tooltip content={fmtDateTime(item.at)}>
            <span className="text-[11px] text-subtle">{fmtRelative(item.at)}</span>
          </Tooltip>
          {canEdit && !editing && (
            <span className="ml-auto hidden gap-0.5 group-hover:flex">
              <Button size="icon-sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit note">
                <Pencil />
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => save.mutate({ visibility: isPublic ? 'internal' : 'public' })} aria-label="Toggle visibility">
                {isPublic ? <EyeOff /> : <Eye />}
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => confirm('Delete this note?') && remove.mutate()} aria-label="Delete note">
                <Trash2 />
              </Button>
            </span>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <ImageTextarea ticketId={ticketId} value={body} onValueChange={setBody} onBusyChange={setBusy} rows={4} />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" loading={save.isPending} disabled={busy || !body.trim()} onClick={() => save.mutate({ body })}>
                Save
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <NoteBody text={item.note.body} className="text-[13px]" />
        )}
      </div>
    </div>
  );
}

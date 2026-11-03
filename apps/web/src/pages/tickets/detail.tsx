import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Building2,
  Clock,
  Copy,
  Eye,
  EyeOff,
  HardDrive,
  Link2,
  Lock,
  Mail,
  MoreHorizontal,
  Paperclip,
  Phone,
  Play,
  Plus,
  Smartphone,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatMinutes, TICKET_RELATION_TYPE } from '@taskora/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth, useMe } from '@/lib/auth';
import { byId, opts, useLookups, userOpts } from '@/lib/lookups';
import { cn, fmtDateTime, fmtRelative, toLocalInput } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, Field, PageLoader, EmptyState } from '@/components/ui/misc';
import { ConfirmDialog, Dialog, DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { PriorityBadge, SlaBadge, StatusBadge } from '@/components/badges';
import { EntityPicker } from '@/components/entity-picker';
import { CustomFieldsEditor, CustomFieldsView } from '@/components/custom-fields';
import { Action1Panel } from '@/components/action1-panel';
import { AtlasTicketCard } from '@/components/atlas-panel';
import { Timeline } from '@/components/tickets/timeline';
import { LogTimeDialog } from '@/components/tickets/log-time-dialog';
import { TicketChecklist } from '@/components/tickets/checklist';
import { useTimer } from '@/components/layout/timer-widget';
import { handleFormError } from '@/components/form';
import type { TicketDetail, TimelineItem } from '@/components/tickets/ticket-types';
import { SendEmailDialog } from '@/components/tickets/email-dialog';
import { CompanyLogo } from '@/components/logo';

interface CiSummary {
  id: number;
  ciNumber: string;
  name: string;
  ciTypeName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  osName: string | null;
  ipAddress: string | null;
  hostname: string | null;
  warrantyExpiresAt: string | null;
  lifecycleStatus: string;
  stats: { openTickets: number; totalTickets: number };
}

export default function TicketDetailPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const lookups = useLookups();
  const L = lookups.data;
  const canWrite = can('tickets.write');

  const ticket = useQuery({ queryKey: ['ticket', id], queryFn: () => api.get<TicketDetail>(`/tickets/${id}`) });
  const timeline = useQuery({ queryKey: ['timeline', id], queryFn: () => api.get<{ data: TimelineItem[] }>(`/tickets/${id}/timeline`) });
  const [filter, setFilter] = useState<'all' | 'notes' | 'public' | 'history' | 'time'>('all');
  const [logTime, setLogTime] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editDescription, setEditDescription] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ticket', id] });
    qc.invalidateQueries({ queryKey: ['timeline', id] });
    qc.invalidateQueries({ queryKey: ['tickets'] });
    qc.invalidateQueries({ queryKey: ['ticket-counts'] });
  };

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/tickets/${id}`, patch),
    onSuccess: refresh,
    onError: (e) => handleFormError(e),
  });

  const timer = useTimer();
  const startTimer = useMutation({
    mutationFn: () => api.post('/timer/start', { ticketId: id }),
    onSuccess: () => {
      toast.success('Timer started');
      qc.invalidateQueries({ queryKey: ['timer'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not start timer'),
  });
  const watch = useMutation({
    mutationFn: (on: boolean) => (on ? api.post(`/tickets/${id}/watch`) : api.delete(`/tickets/${id}/watch`)),
    onSuccess: refresh,
  });
  const merge = useMutation({
    mutationFn: () => api.post<{ ticketId: number }>(`/tickets/${id}/merge`, { intoTicketId: mergeTarget }),
    onSuccess: (r) => {
      toast.success('Tickets merged');
      setMergeOpen(false);
      qc.invalidateQueries({ queryKey: ['tickets'] });
      navigate(`/tickets/${r.ticketId}`);
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/tickets/${id}`),
    onSuccess: () => {
      toast.success('Ticket deleted');
      qc.invalidateQueries({ queryKey: ['tickets'] });
      navigate('/tickets');
    },
    onError: (e) => handleFormError(e),
  });

  useEffect(() => {
    if (ticket.data) document.title = `${ticket.data.ticketNumber} ${ticket.data.title} · Taskora`;
  }, [ticket.data]);

  if (ticket.isLoading) return <PageLoader />;
  if (ticket.isError || !ticket.data) return <EmptyState title="Ticket not found" action={<Button onClick={() => navigate('/tickets')}>Back to tickets</Button>} />;
  const t = ticket.data;
  const isDone = t.statusCategory === 'resolved' || t.statusCategory === 'closed';

  const changeStatus = (statusId: number) => {
    const st = byId(L?.statuses, statusId);
    if (st && (st.category === 'resolved' || st.category === 'closed') && !t.resolution) return setResolveOpen(statusId);
    update.mutate({ statusId });
  };

  const timerOnThis = timer.data?.ticketId === id;

  return (
    <div className="flex min-h-full flex-col">
      {/* ------------------------------------------------------------ header */}
      <div className="border-b border-border bg-surface px-5 pb-3 pt-3">
        <nav className="mb-1 flex items-center gap-1 text-xs text-muted">
          <Link to="/tickets" className="hover:text-foreground">
            Service Desk
          </Link>
          <span>/</span>
          <Link to={`/companies/${t.companyId}`} className="hover:text-foreground">
            {t.companyName}
          </Link>
          <span>/</span>
          <span className="font-mono">{t.ticketNumber}</span>
          <button
            className="ml-1 cursor-pointer text-subtle hover:text-foreground"
            onClick={() => {
              navigator.clipboard?.writeText(t.ticketNumber);
              toast.success('Ticket number copied');
            }}
            aria-label="Copy ticket number"
          >
            <Copy className="size-3" />
          </button>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <InlineTitle value={t.title} disabled={!canWrite} onSave={(title) => update.mutate({ title })} />
          <div className="flex flex-wrap items-center gap-2">
            {can('time.write') &&
              (timerOnThis ? (
                <Badge tone="primary" className="h-8 px-2.5">
                  <Clock className="size-3.5 animate-pulse" /> Timer running
                </Badge>
              ) : (
                <Button onClick={() => startTimer.mutate()} loading={startTimer.isPending} disabled={!!timer.data}>
                  <Play /> Start timer
                </Button>
              ))}
            {can('time.write') && (
              <Button onClick={() => setLogTime(true)}>
                <Clock /> Log time
              </Button>
            )}
            {canWrite && (
              <Button onClick={() => setEmailOpen(true)}>
                <Mail /> Send e-mail
              </Button>
            )}
            <Button onClick={() => watch.mutate(!t.isWatching)} loading={watch.isPending}>
              {t.isWatching ? <EyeOff /> : <Eye />} {t.isWatching ? 'Unwatch' : 'Watch'}
            </Button>
            <DropdownMenu>
              <DropdownTrigger asChild>
                <Button size="icon" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownTrigger>
              <DropdownContent>
                {canWrite && (
                  <DropdownItem onSelect={() => navigate(`/tickets/new?companyId=${t.companyId}${t.contactId ? `&contactId=${t.contactId}` : ''}`)}>
                    <Plus /> New ticket for this customer
                  </DropdownItem>
                )}
                {canWrite && (
                  <DropdownItem onSelect={() => setMergeOpen(true)}>
                    <Copy /> Merge into another ticket…
                  </DropdownItem>
                )}
                <DropdownItem
                  onSelect={() => {
                    navigator.clipboard?.writeText(window.location.href);
                    toast.success('Link copied');
                  }}
                >
                  <Link2 /> Copy link
                </DropdownItem>
                {can('tickets.delete') && (
                  <>
                    <DropdownSeparator />
                    <DropdownItem danger onSelect={() => setDeleteOpen(true)}>
                      <Trash2 /> Delete ticket
                    </DropdownItem>
                  </>
                )}
              </DropdownContent>
            </DropdownMenu>
          </div>
        </div>
        {/* quick fields */}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <QuickSelect label="Status" disabled={!canWrite} value={t.statusId} options={opts(L?.statuses, t.statusId)} onChange={(v) => v && changeStatus(v)}>
            <StatusBadge name={t.statusName} color={t.statusColor} />
          </QuickSelect>
          <QuickSelect label="Priority" disabled={!canWrite} value={t.priorityId} options={opts(L?.priorities, t.priorityId)} onChange={(v) => v && update.mutate({ priorityId: v })}>
            <PriorityBadge name={t.priorityName} color={t.priorityColor} level={t.priorityLevel} />
          </QuickSelect>
          <QuickSelect
            label="Assigned"
            disabled={!canWrite}
            value={t.assignedUserId}
            options={userOpts(L?.users, t.assignedUserId)}
            allowEmpty="Unassigned"
            onChange={(v) => update.mutate({ assignedUserId: v })}
          >
            <span className={cn(!t.assigneeName && 'text-subtle')}>{t.assigneeName ?? 'Unassigned'}</span>
          </QuickSelect>
          <QuickSelect label="Queue" disabled={!canWrite} value={t.queueId} options={opts(L?.queues, t.queueId)} allowEmpty="No queue" onChange={(v) => update.mutate({ queueId: v })}>
            <span>{t.queueName ?? '—'}</span>
          </QuickSelect>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-subtle">SLA</span>
            <SlaBadge state={t.sla.overall} due={isDone ? null : !t.firstResponseAt ? t.firstResponseDueAt : t.resolutionDueAt} />
          </div>
          {!t.assignedUserId && canWrite && <AssignToMe ticketId={id} onDone={refresh} />}
        </div>
      </div>

      {/* -------------------------------------------------------------- body */}
      <div className="grid flex-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader
              title="Description"
              actions={
                canWrite && !editDescription && (
                  <Button size="sm" variant="ghost" onClick={() => setEditDescription(true)}>
                    Edit
                  </Button>
                )
              }
            />
            <CardBody>
              {editDescription ? (
                <EditText
                  initial={t.description ?? ''}
                  rows={8}
                  onCancel={() => setEditDescription(false)}
                  onSave={(description) => update.mutate({ description }, { onSuccess: () => setEditDescription(false) })}
                />
              ) : t.description ? (
                <p className="prose-note text-[13px]">{t.description}</p>
              ) : (
                <p className="text-xs text-muted">No description.</p>
              )}
              {(t.resolution || isDone) && (
                <div className="mt-4 rounded-md border border-success/30 bg-success-soft/50 p-3">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-success">Resolution</div>
                  {t.resolution ? <p className="prose-note text-[13px]">{t.resolution}</p> : <p className="text-xs text-muted">No resolution recorded.</p>}
                </div>
              )}
            </CardBody>
          </Card>

          {canWrite && <Composer ticket={t} onPosted={refresh} onResolveRequired={(sid) => setResolveOpen(sid)} />}

          <Card>
            <Tabs defaultValue="activity">
              <div className="px-2">
                <TabsList className="border-b-0">
                  <TabsTrigger value="activity" count={timeline.data?.data.length}>
                    Activity
                  </TabsTrigger>
                  <TabsTrigger value="related">Related tickets</TabsTrigger>
                  <TabsTrigger value="files">Attachments</TabsTrigger>
                  <TabsTrigger value="kb">Knowledge</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="activity" className="border-t border-border p-4">
                <div className="mb-3 flex flex-wrap gap-1">
                  {(
                    [
                      ['all', 'Everything'],
                      ['notes', 'All notes'],
                      ['public', 'Customer-visible'],
                      ['time', 'Time entries'],
                      ['history', 'History'],
                    ] as const
                  ).map(([k, label]) => (
                    <Button key={k} size="sm" variant={filter === k ? 'subtle' : 'ghost'} onClick={() => setFilter(k)}>
                      {label}
                    </Button>
                  ))}
                </div>
                {timeline.isLoading ? <PageLoader /> : <Timeline ticketId={id} items={timeline.data?.data ?? []} filter={filter} />}
              </TabsContent>
              <TabsContent value="related" className="border-t border-border p-4">
                <RelatedTickets ticket={t} canWrite={canWrite} />
              </TabsContent>
              <TabsContent value="files" className="border-t border-border p-4">
                <Attachments entityType="ticket" entityId={id} canWrite={canWrite} onChange={refresh} />
              </TabsContent>
              <TabsContent value="kb" className="border-t border-border p-4">
                <LinkedArticles ticketId={id} canWrite={canWrite} />
              </TabsContent>
            </Tabs>
          </Card>
        </div>

        {/* ------------------------------------------------------ side panel */}
        <aside className="space-y-4">
          <TicketChecklist ticketId={id} canWrite={canWrite} />
          <ContactCard t={t} canWrite={canWrite} onChange={(contactId) => update.mutate({ contactId })} />
          <DeviceCard t={t} canWrite={canWrite} onChange={(configurationItemId) => update.mutate({ configurationItemId })} />
          {t.tags.includes('atlas') && <AtlasTicketCard ticketId={t.id} />}
          <Card>
            <CardHeader title="Classification" />
            <CardBody className="space-y-2.5">
              <SideSelect label="Ticket type" value={t.ticketTypeId} disabled={!canWrite} options={opts(L?.ticketTypes, t.ticketTypeId)} onChange={(v) => update.mutate({ ticketTypeId: v })} />
              <SideSelect
                label="Issue type"
                value={t.issueTypeId}
                disabled={!canWrite}
                options={opts(L?.issueTypes, t.issueTypeId)}
                onChange={(v) => update.mutate({ issueTypeId: v, subIssueTypeId: null })}
              />
              <SideSelect
                label="Sub-issue type"
                value={t.subIssueTypeId}
                disabled={!canWrite || !t.issueTypeId}
                options={(L?.subIssueTypes ?? []).filter((x) => x.issueTypeId === t.issueTypeId && (x.isActive !== false || x.id === t.subIssueTypeId)).map((x) => ({ value: x.id, label: x.name }))}
                onChange={(v) => update.mutate({ subIssueTypeId: v })}
              />
              <SideSelect label="Source" value={t.sourceId} disabled={!canWrite} options={opts(L?.sources, t.sourceId)} onChange={(v) => update.mutate({ sourceId: v })} />
            </CardBody>
          </Card>
          <ContractCard t={t} canWrite={canWrite} onChange={(patch) => update.mutate(patch)} />
          <Card>
            <CardHeader title="Dates & effort" />
            <CardBody>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <Field label="Created">{fmtDateTime(t.createdAt)}</Field>
                <Field label="Created by">{t.creatorName ?? 'System'}</Field>
                <Field label="Last activity">{fmtRelative(t.lastActivityAt)}</Field>
                <Field label="First response">{t.firstResponseAt ? fmtDateTime(t.firstResponseAt) : null}</Field>
                <Field label="Resolved">{t.resolvedAt ? fmtDateTime(t.resolvedAt) : null}</Field>
                <Field label="Closed">{t.closedAt ? fmtDateTime(t.closedAt) : null}</Field>
                <Field label="Worked">{formatMinutes(t.minutesWorked)}</Field>
                <Field label="Estimated">{t.estimatedHours ? `${t.estimatedHours} h` : null}</Field>
              </dl>
              {canWrite && (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div>
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">Due date</div>
                    <Input
                      type="datetime-local"
                      defaultValue={toLocalInput(t.dueAt)}
                      key={t.dueAt ?? 'none'}
                      onBlur={(e) => {
                        const v = e.target.value ? new Date(e.target.value).toISOString() : null;
                        if ((v ?? null) !== (t.dueAt ? new Date(t.dueAt).toISOString() : null)) update.mutate({ dueAt: v });
                      }}
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">Estimate (h)</div>
                    <Input
                      type="number"
                      step="0.25"
                      min="0"
                      defaultValue={t.estimatedHours ?? ''}
                      key={String(t.estimatedHours)}
                      onBlur={(e) => {
                        const v = e.target.value === '' ? null : Number(e.target.value);
                        if (v !== t.estimatedHours) update.mutate({ estimatedHours: v });
                      }}
                    />
                  </div>
                </div>
              )}
            </CardBody>
          </Card>
          <TagsCard tags={t.tags} disabled={!canWrite} onChange={(tags) => update.mutate({ tags })} />
          <Card>
            <CardHeader title="Watchers" />
            <CardBody>
              {t.watchers.length ? (
                <ul className="space-y-1 text-[13px]">
                  {t.watchers.map((w) => (
                    <li key={w.userId}>{w.name}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">Nobody is watching this ticket.</p>
              )}
            </CardBody>
          </Card>
          <CustomFieldsCard t={t} canWrite={canWrite} onSave={(customFields) => update.mutate({ customFields })} />
        </aside>
      </div>

      <LogTimeDialog open={logTime} onOpenChange={setLogTime} ticketId={id} />
      {canWrite && <SendEmailDialog ticket={t} open={emailOpen} onOpenChange={setEmailOpen} onSent={refresh} />}
      {resolveOpen !== null && (
        <ResolveDialog
          statusId={resolveOpen}
          statusName={byId(L?.statuses, resolveOpen)?.name ?? 'Resolved'}
          initial={t.resolution ?? ''}
          onClose={() => setResolveOpen(null)}
          onSave={(resolution, note) =>
            update.mutate(
              { statusId: resolveOpen, resolution },
              {
                onSuccess: async () => {
                  if (note) await api.post(`/tickets/${id}/notes`, { body: resolution, visibility: 'public' });
                  setResolveOpen(null);
                  refresh();
                  toast.success('Ticket resolved');
                },
              },
            )
          }
          loading={update.isPending}
        />
      )}
      <Dialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        title={`Merge ${t.ticketNumber} into…`}
        description="Notes, time entries, attachments, checklist items and watchers move to the selected ticket of the same company; this ticket is closed as a duplicate."
        footer={
          <>
            <Button onClick={() => setMergeOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!mergeTarget} loading={merge.isPending} onClick={() => merge.mutate()}>
              Merge
            </Button>
          </>
        }
      >
        <EntityPicker kind="ticket" value={mergeTarget} onChange={setMergeTarget} filter={{ companyId: t.companyId, statusCategory: 'all' }} placeholder="Find the ticket to keep…" />
      </Dialog>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${t.ticketNumber}?`}
        description="This permanently removes the ticket with its notes, time entries and history. Closing the ticket is usually preferable."
        confirmLabel="Delete ticket"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function InlineTitle({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!editing || disabled) {
    return (
      <h1 className={cn('min-w-0 flex-1 text-lg font-semibold tracking-tight', !disabled && 'cursor-text rounded hover:bg-surface-2')} onClick={() => !disabled && setEditing(true)} title={disabled ? undefined : 'Click to edit'}>
        {value}
      </h1>
    );
  }
  const commit = () => {
    setEditing(false);
    if (v.trim() && v.trim() !== value) onSave(v.trim());
    else setV(value);
  };
  return (
    <Input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setV(value);
          setEditing(false);
        }
      }}
      className="h-9 min-w-0 flex-1 text-lg font-semibold"
    />
  );
}

function QuickSelect({
  label,
  value,
  options,
  onChange,
  children,
  disabled,
  allowEmpty,
}: {
  label: string;
  value: number | null;
  options: { value: string | number; label: string }[];
  onChange: (v: number | null) => void;
  children: React.ReactNode;
  disabled?: boolean;
  allowEmpty?: string;
}) {
  return (
    <label className={cn('relative flex items-center gap-1.5', !disabled && 'cursor-pointer')}>
      <span className="text-[11px] uppercase tracking-wide text-subtle">{label}</span>
      <span className={cn('rounded px-1 py-0.5', !disabled && 'hover:bg-surface-2')}>{children}</span>
      {!disabled && (
        <select
          aria-label={label}
          className="absolute inset-0 cursor-pointer opacity-0"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        >
          {allowEmpty && <option value="">{allowEmpty}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </label>
  );
}

function SideSelect({ label, value, options, onChange, disabled }: { label: string; value: number | null; options: { value: string | number; label: string }[]; onChange: (v: number | null) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-subtle">{label}</span>
      <Select value={value ?? ''} disabled={disabled} placeholder="—" options={options} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} className="h-7" />
    </div>
  );
}

function AssignToMe({ ticketId, onDone }: { ticketId: number; onDone: () => void }) {
  const me = useMe();
  const m = useMutation({ mutationFn: () => api.patch(`/tickets/${ticketId}`, { assignedUserId: me.user.id }), onSuccess: onDone });
  return (
    <Button size="sm" variant="subtle" onClick={() => m.mutate()} loading={m.isPending}>
      <UserRound /> Assign to me
    </Button>
  );
}

function EditText({ initial, onSave, onCancel, rows = 4 }: { initial: string; onSave: (v: string) => void; onCancel: () => void; rows?: number }) {
  const [v, setV] = useState(initial);
  return (
    <div className="space-y-2">
      <Textarea value={v} rows={rows} onChange={(e) => setV(e.target.value)} autoFocus />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => onSave(v)}>
          Save
        </Button>
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Note composer: internal or customer-visible note, optional status change. */
function Composer({ ticket, onPosted, onResolveRequired }: { ticket: TicketDetail; onPosted: () => void; onResolveRequired: (statusId: number) => void }) {
  const lookups = useLookups();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'internal' | 'public'>('internal');
  const [statusId, setStatusId] = useState('');
  const [logTime, setLogTime] = useState(false);
  const me = useMe();
  const canMail = me.emailEnabled && !!ticket.contactEmail;
  const [mailContact, setMailContact] = useState(true);
  const ref = useRef<HTMLTextAreaElement>(null);
  const post = useMutation({
    mutationFn: () =>
      api.post(`/tickets/${ticket.id}/notes`, { body, visibility, statusId: statusId ? Number(statusId) : null, notifyContact: visibility === 'public' && canMail && mailContact }),
    onSuccess: () => {
      toast.success(visibility === 'public' ? 'Customer-visible note added' : 'Internal note added');
      setBody('');
      setStatusId('');
      onPosted();
    },
    onError: (e) => handleFormError(e),
  });
  const submit = () => {
    if (!body.trim()) return;
    const st = byId(lookups.data?.statuses, statusId ? Number(statusId) : null);
    if (st && (st.category === 'resolved' || st.category === 'closed') && !ticket.resolution) {
      post.mutate(undefined, { onSuccess: () => onResolveRequired(st.id) });
      return;
    }
    post.mutate();
  };
  return (
    <Card className={cn(visibility === 'public' && 'border-primary/40')}>
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        <Button size="sm" variant={visibility === 'internal' ? 'subtle' : 'ghost'} onClick={() => setVisibility('internal')}>
          <Lock /> Internal note
        </Button>
        <Button size="sm" variant={visibility === 'public' ? 'subtle' : 'ghost'} onClick={() => setVisibility('public')} className={cn(visibility === 'public' && 'text-primary')}>
          <Eye /> Customer-visible
        </Button>
        <span className="ml-auto text-[11px] text-subtle">Ctrl+Enter to post</span>
      </div>
      <div className="p-3">
        <Textarea
          ref={ref}
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          }}
          placeholder={visibility === 'public' ? 'Reply visible to the customer…' : 'Troubleshooting notes, findings, next steps…'}
          className="border-0 px-0 shadow-none focus:ring-0"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="w-52">
            <Select value={statusId} onChange={(e) => setStatusId(e.target.value)} placeholder="Keep status" options={opts(lookups.data?.statuses).filter((o) => o.value !== ticket.statusId)} className="h-7" />
          </div>
          <Button size="sm" variant="ghost" onClick={() => setLogTime(true)}>
            <Clock /> Log time with this note
          </Button>
          {visibility === 'public' && canMail && (
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={mailContact} onChange={(e) => setMailContact(e.target.checked)} className="accent-[var(--primary)]" />
              E-mail to {ticket.contactEmail}
            </label>
          )}
          <Button size="sm" variant="primary" className="ml-auto" disabled={!body.trim()} loading={post.isPending} onClick={submit}>
            Post note
          </Button>
        </div>
      </div>
      <LogTimeDialog open={logTime} onOpenChange={setLogTime} ticketId={ticket.id} defaultDescription={body} />
    </Card>
  );
}

function ResolveDialog({ statusName, initial, onClose, onSave, loading }: { statusId: number; statusName: string; initial: string; onClose: () => void; onSave: (resolution: string, addNote: boolean) => void; loading: boolean }) {
  const [resolution, setResolution] = useState(initial);
  const [note, setNote] = useState(true);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Set status to ${statusName}`}
      description="Record how the issue was resolved. The resolution is kept on the ticket and can be reused in the knowledge base."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!resolution.trim()} loading={loading} onClick={() => onSave(resolution.trim(), note)}>
            Resolve ticket
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Textarea rows={6} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Root cause and the fix applied…" />
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={note} onChange={(e) => setNote(e.target.checked)} className="accent-[var(--primary)]" /> Also post the resolution as a customer-visible note
        </label>
      </div>
    </Dialog>
  );
}

function ContactCard({ t, canWrite, onChange }: { t: TicketDetail; canWrite: boolean; onChange: (id: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Contact"
        actions={
          canWrite && (
            <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>
              {editing ? 'Done' : 'Change'}
            </Button>
          )
        }
      />
      <CardBody className="space-y-2">
        {editing && <EntityPicker kind="contact" value={t.contactId} label={t.contactName} filter={{ companyId: t.companyId }} onChange={(id) => onChange(id)} />}
        {t.contactId ? (
          <div className="space-y-1.5 text-[13px]">
            <Link to={`/contacts/${t.contactId}`} className="flex items-center gap-1.5 font-medium hover:text-primary">
              <UserRound className="size-3.5 text-muted" /> {t.contactName}
            </Link>
            {t.contactTitle && <div className="text-xs text-muted">{t.contactTitle}</div>}
            {t.contactEmail && (
              <a href={`mailto:${t.contactEmail}?subject=${encodeURIComponent(`[${t.ticketNumber}] ${t.title}`)}`} className="flex items-center gap-1.5 text-primary hover:underline">
                <Mail className="size-3.5" /> {t.contactEmail}
              </a>
            )}
            {t.contactPhone && (
              <a href={`tel:${t.contactPhone}`} className="flex items-center gap-1.5 hover:text-primary">
                <Phone className="size-3.5 text-muted" /> {t.contactPhone}
              </a>
            )}
            {t.contactMobile && (
              <a href={`tel:${t.contactMobile}`} className="flex items-center gap-1.5 hover:text-primary">
                <Smartphone className="size-3.5 text-muted" /> {t.contactMobile}
              </a>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted">No contact linked.</p>
        )}
        <div className="flex items-center gap-1.5 border-t border-border pt-2 text-[13px]">
          {t.companyLogoUpdatedAt ? <CompanyLogo companyId={t.companyId} name={t.companyName} logoUpdatedAt={t.companyLogoUpdatedAt} className="size-5" /> : <Building2 className="size-3.5 text-muted" />}
          <Link to={`/companies/${t.companyId}`} className="font-medium hover:text-primary">
            {t.companyName}
          </Link>
          {t.companyPhone && <span className="ml-auto text-xs text-muted">{t.companyPhone}</span>}
        </div>
        {t.locationName && <div className="text-xs text-muted">Location: {t.locationName}</div>}
      </CardBody>
    </Card>
  );
}

function DeviceCard({ t, canWrite, onChange }: { t: TicketDetail; canWrite: boolean; onChange: (id: number | null) => void }) {
  const [editing, setEditing] = useState(false);
  const ci = useQuery({
    queryKey: ['ci', t.configurationItemId],
    queryFn: () => api.get<CiSummary>(`/configuration-items/${t.configurationItemId}`),
    enabled: !!t.configurationItemId,
  });
  return (
    <Card>
      <CardHeader
        title="Configuration item"
        actions={
          canWrite && (
            <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>
              {editing ? 'Done' : t.configurationItemId ? 'Change' : 'Link device'}
            </Button>
          )
        }
      />
      <CardBody className="space-y-3">
        {editing && <EntityPicker kind="ci" value={t.configurationItemId} label={ci.data?.name} filter={{ companyId: t.companyId }} onChange={(id) => onChange(id)} />}
        {t.configurationItemId && ci.data ? (
          <>
            <div>
              <Link to={`/assets/${ci.data.id}`} className="flex items-center gap-1.5 text-[13px] font-medium hover:text-primary">
                <HardDrive className="size-3.5 text-muted" /> {ci.data.name}
              </Link>
              <div className="mt-0.5 text-xs text-muted">
                {[ci.data.ciTypeName, [ci.data.manufacturer, ci.data.model].filter(Boolean).join(' '), ci.data.serialNumber].filter(Boolean).join(' · ')}
              </div>
              {ci.data.stats.openTickets > 1 && (
                <Link to={`/tickets?configurationItemId=${ci.data.id}`} className="mt-1 inline-block text-xs text-warning hover:underline">
                  {ci.data.stats.openTickets - 1} other open ticket(s) on this device
                </Link>
              )}
            </div>
            <div className="border-t border-border pt-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">Action1 endpoint</div>
              <Action1Panel ciId={ci.data.id} compact />
            </div>
          </>
        ) : !t.configurationItemId ? (
          <p className="text-xs text-muted">No device linked. Link the affected device to see live endpoint information.</p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ContractCard({ t, canWrite, onChange }: { t: TicketDetail; canWrite: boolean; onChange: (p: Record<string, unknown>) => void }) {
  const lookups = useLookups();
  const contracts = useQuery({
    queryKey: ['contracts', 'company', t.companyId],
    queryFn: () => api.get<{ data: { id: number; name: string; isDefault: boolean }[] }>('/contracts', { companyId: t.companyId, status: 'active', pageSize: 100 }),
    enabled: canWrite,
  });
  const contractOptions = [...(contracts.data?.data ?? [])];
  if (t.contractId && !contractOptions.some((c) => c.id === t.contractId)) contractOptions.push({ id: t.contractId, name: t.contractName ?? `#${t.contractId}`, isDefault: false });
  return (
    <Card>
      <CardHeader title="Contract & SLA" />
      <CardBody className="space-y-2.5">
        <div className="grid grid-cols-[110px_1fr] items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-subtle">Contract</span>
          {canWrite ? (
            <Select
              value={t.contractId ?? ''}
              onChange={(e) => onChange({ contractId: e.target.value ? Number(e.target.value) : null })}
              placeholder="No contract"
              options={contractOptions.map((c) => ({ value: c.id, label: c.name }))}
              className="h-7"
            />
          ) : t.contractId ? (
            <Link to={`/contracts/${t.contractId}`} className="text-[13px] hover:text-primary">
              {t.contractName}
            </Link>
          ) : (
            <span className="text-subtle">—</span>
          )}
        </div>
        <SideSelect label="SLA policy" value={t.slaId} disabled={!canWrite} options={opts(lookups.data?.slaPolicies, t.slaId)} onChange={(v) => onChange({ slaId: v })} />
        <div className="space-y-2 rounded-md bg-surface-2 p-2.5">
          <SlaRow label="First response" state={t.sla.firstResponse} due={t.firstResponseDueAt} done={t.firstResponseAt} />
          <SlaRow label="Resolution" state={t.sla.resolution} due={t.resolutionDueAt} done={t.resolvedAt} />
          {t.slaPausedAt && <p className="text-[11px] text-muted">Clock paused since {fmtDateTime(t.slaPausedAt)}</p>}
          {t.slaPausedMinutes > 0 && <p className="text-[11px] text-muted">Total paused: {formatMinutes(t.slaPausedMinutes)} (business time)</p>}
        </div>
        {t.contractId && (
          <Link to={`/contracts/${t.contractId}`} className="block text-xs text-primary hover:underline">
            View contract
          </Link>
        )}
      </CardBody>
    </Card>
  );
}

function SlaRow({ label, state, due, done }: { label: string; state: TicketDetail['sla']['overall']; due: string | null; done: string | null }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-[11px] text-muted">{done ? `Done ${fmtDateTime(done)}` : due ? `Due ${fmtDateTime(due)}` : 'No target'}</div>
      </div>
      <SlaBadge state={state} />
    </div>
  );
}

function TagsCard({ tags, onChange, disabled }: { tags: string[]; onChange: (t: string[]) => void; disabled?: boolean }) {
  const [v, setV] = useState('');
  const add = () => {
    const tag = v.trim().toLowerCase();
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setV('');
  };
  return (
    <Card>
      <CardHeader title="Tags" />
      <CardBody className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {tags.length === 0 && <span className="text-xs text-muted">No tags</span>}
          {tags.map((tag) => (
            <Badge key={tag} tone="primary">
              {tag}
              {!disabled && (
                <button className="cursor-pointer" onClick={() => onChange(tags.filter((x) => x !== tag))} aria-label={`Remove ${tag}`}>
                  <X className="size-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
        {!disabled && (
          <Input
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Add tag and press Enter"
            className="h-7"
          />
        )}
      </CardBody>
    </Card>
  );
}

function CustomFieldsCard({ t, canWrite, onSave }: { t: TicketDetail; canWrite: boolean; onSave: (v: Record<string, unknown>) => void }) {
  const lookups = useLookups();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(t.customFields);
  useEffect(() => setValue(t.customFields), [t.customFields]);
  if (!(lookups.data?.customFields ?? []).some((d) => d.entity === 'ticket' && d.isActive)) return null;
  return (
    <Card>
      <CardHeader
        title="Custom fields"
        actions={
          canWrite && (
            <Button size="sm" variant="ghost" onClick={() => (editing ? (onSave(value), setEditing(false)) : setEditing(true))}>
              {editing ? 'Save' : 'Edit'}
            </Button>
          )
        }
      />
      <CardBody>
        {editing ? (
          <CustomFieldsEditor entity="ticket" value={value} onChange={setValue} />
        ) : (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <CustomFieldsView entity="ticket" value={t.customFields} />
          </dl>
        )}
      </CardBody>
    </Card>
  );
}

interface Relation {
  id: number;
  type: string;
  direction: 'incoming' | 'outgoing';
  ticketId: number;
  ticketNumber: string;
  title: string;
  statusName: string;
  statusColor: string;
}

function RelatedTickets({ ticket, canWrite }: { ticket: TicketDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const rel = useQuery({ queryKey: ['relations', ticket.id], queryFn: () => api.get<{ data: Relation[] }>(`/tickets/${ticket.id}/relations`) });
  const [target, setTarget] = useState<number | null>(null);
  const [type, setType] = useState('related');
  const add = useMutation({
    mutationFn: () => api.post(`/tickets/${ticket.id}/relations`, { relatedTicketId: target, type }),
    onSuccess: () => {
      setTarget(null);
      qc.invalidateQueries({ queryKey: ['relations', ticket.id] });
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: (rid: number) => api.delete(`/tickets/${ticket.id}/relations/${rid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relations', ticket.id] }),
  });
  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-40">
            <Select value={type} onChange={(e) => setType(e.target.value)} options={TICKET_RELATION_TYPE.values.map((v) => ({ value: v, label: TICKET_RELATION_TYPE.labels[v] }))} />
          </div>
          <div className="min-w-64 flex-1">
            <EntityPicker kind="ticket" value={target} onChange={setTarget} placeholder="Find a ticket…" />
          </div>
          <Button variant="primary" disabled={!target} loading={add.isPending} onClick={() => add.mutate()}>
            Link
          </Button>
        </div>
      )}
      {(rel.data?.data ?? []).length === 0 ? (
        <p className="text-xs text-muted">No related tickets.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rel.data!.data.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <Badge>{TICKET_RELATION_TYPE.labels[r.type as keyof typeof TICKET_RELATION_TYPE.labels] ?? r.type}</Badge>
              <Link to={`/tickets/${r.ticketId}`} className="min-w-0 flex-1 truncate hover:text-primary">
                <span className="font-mono text-xs text-muted">{r.ticketNumber}</span> {r.title}
              </Link>
              <StatusBadge name={r.statusName} color={r.statusColor} />
              {canWrite && (
                <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(r.id)} aria-label="Remove relation">
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface AttachmentRow {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: string | null;
}

export function Attachments({ entityType, entityId, canWrite, onChange }: { entityType: string; entityId: number; canWrite: boolean; onChange?: () => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['attachments', entityType, entityId], queryFn: () => api.get<{ data: AttachmentRow[] }>(`/attachments/${entityType}/${entityId}`) });
  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload(`/attachments/${entityType}/${entityId}`, files),
    onSuccess: () => {
      toast.success('Uploaded');
      qc.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
      onChange?.();
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/attachments/file/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attachments', entityType, entityId] }),
    onError: (e) => handleFormError(e),
  });
  return (
    <div
      className="space-y-3"
      onDragOver={(e) => canWrite && e.preventDefault()}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        const files = [...e.dataTransfer.files];
        if (files.length) upload.mutate(files);
      }}
    >
      {canWrite && (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border-strong px-4 py-4 text-xs text-muted">
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              if (files.length) upload.mutate(files);
              e.target.value = '';
            }}
          />
          <Button size="sm" onClick={() => input.current?.click()} loading={upload.isPending}>
            <Paperclip /> Upload files
          </Button>
          <span className="ml-2">or drag & drop here</span>
        </div>
      )}
      {(list.data?.data ?? []).length === 0 ? (
        <p className="text-xs text-muted">No attachments.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {list.data!.data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <Paperclip className="size-3.5 text-muted" />
              <a href={`/api/v1/attachments/file/${f.id}`} className="min-w-0 flex-1 truncate hover:text-primary">
                {f.fileName}
              </a>
              <span className="text-xs text-muted">{(f.sizeBytes / 1024).toFixed(0)} KB</span>
              <span className="text-xs text-muted">
                {f.uploadedBy} · {fmtRelative(f.createdAt)}
              </span>
              {canWrite && (
                <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(f.id)} aria-label="Delete file">
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LinkedArticles({ ticketId, canWrite }: { ticketId: number; canWrite: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const linked = useQuery({ queryKey: ['ticket-kb', ticketId], queryFn: () => api.get<{ data: { id: number; articleNumber: string; title: string }[] }>(`/tickets/${ticketId}/kb`) });
  const search = useQuery({
    queryKey: ['kb-search', q],
    queryFn: () => api.get<{ data: { id: number; articleNumber: string; title: string; excerpt: string }[] }>('/kb/articles', { q, pageSize: 6, status: 'published' }),
    enabled: q.trim().length > 1,
  });
  const link = useMutation({
    mutationFn: (articleId: number) => api.post(`/kb/articles/${articleId}/tickets`, { ticketId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ticket-kb', ticketId] }),
  });
  const unlink = useMutation({
    mutationFn: (articleId: number) => api.delete(`/kb/articles/${articleId}/tickets/${ticketId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ticket-kb', ticketId] }),
  });
  return (
    <div className="space-y-3">
      {(linked.data?.data ?? []).length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {linked.data!.data.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              <BookOpen className="size-3.5 text-muted" />
              <Link to={`/kb/${a.id}`} className="flex-1 hover:text-primary">
                <span className="font-mono text-xs text-muted">{a.articleNumber}</span> {a.title}
              </Link>
              {canWrite && (
                <Button size="icon-sm" variant="ghost" onClick={() => unlink.mutate(a.id)} aria-label="Unlink article">
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the knowledge base…" />
      {(search.data?.data ?? []).map((a) => (
        <div key={a.id} className="rounded-md border border-border p-2.5">
          <div className="flex items-center gap-2">
            <Link to={`/kb/${a.id}`} target="_blank" className="flex-1 text-[13px] font-medium hover:text-primary">
              {a.title}
            </Link>
            {canWrite && !linked.data?.data.some((x) => x.id === a.id) && (
              <Button size="sm" onClick={() => link.mutate(a.id)}>
                Link
              </Button>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted">{a.excerpt}</p>
        </div>
      ))}
    </div>
  );
}

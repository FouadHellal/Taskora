import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { byId, opts, useLookups, userOpts } from '@/lib/lookups';
import { cn, toLocalInput } from '@/lib/utils';
import { Button } from '../ui/button';
import { Checkbox, Input, Select, Textarea } from '../ui/input';
import { Dialog } from '../ui/overlays';
import { FormField, FormGrid, handleFormError } from '../form';
import { EntityPicker } from '../entity-picker';
import type { TimeEntryRow } from './related-lists';
import { TicketLink } from '@/lib/open-ticket';

interface FormValues {
  target: 'ticket' | 'task';
  userId: string;
  ticketId: number | null;
  projectTaskId: number | null;
  workTypeId: string;
  startedAt: string;
  durationMinutes: string;
  billable: boolean;
  description: string;
  internalNotes: string;
}

const QUICK = [15, 30, 45, 60, 90, 120];

export interface TimeEntryDefaults {
  ticketId?: number | null;
  ticketLabel?: string | null;
  projectTaskId?: number | null;
  taskLabel?: string | null;
}

export function TimeEntryDialog({
  open,
  onOpenChange,
  entry,
  defaults,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entry?: TimeEntryRow | null;
  defaults?: TimeEntryDefaults;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const lookups = useLookups();
  const { register, handleSubmit, reset, setError, control, formState, watch, setValue } = useForm<FormValues>();

  useEffect(() => {
    if (!open) return;
    if (entry) {
      reset({
        target: entry.ticketId ? 'ticket' : 'task',
        userId: String(entry.userId),
        ticketId: entry.ticketId,
        projectTaskId: entry.projectTaskId,
        workTypeId: entry.workTypeId ? String(entry.workTypeId) : '',
        startedAt: toLocalInput(entry.startedAt),
        durationMinutes: String(entry.durationMinutes),
        billable: entry.billable,
        description: entry.description,
        internalNotes: entry.internalNotes ?? '',
      });
    } else {
      reset({
        target: defaults?.projectTaskId ? 'task' : 'ticket',
        userId: me ? String(me.user.id) : '',
        ticketId: defaults?.ticketId ?? null,
        projectTaskId: defaults?.projectTaskId ?? null,
        workTypeId: '',
        startedAt: toLocalInput(new Date(Date.now() - 30 * 60_000)),
        durationMinutes: '30',
        billable: true,
        description: '',
        internalNotes: '',
      });
    }
  }, [open, entry, defaults, reset, me]);

  const target = watch('target');
  const duration = Number(watch('durationMinutes') || 0);

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const startedAt = new Date(v.startedAt);
      const common = {
        workTypeId: v.workTypeId ? Number(v.workTypeId) : null,
        startedAt: Number.isNaN(startedAt.getTime()) ? v.startedAt : startedAt.toISOString(),
        durationMinutes: v.durationMinutes,
        billable: v.billable,
        description: v.description,
        internalNotes: v.internalNotes || null,
      };
      if (entry) return api.patch(`/time-entries/${entry.id}`, common);
      return api.post('/time-entries', {
        ...common,
        userId: v.userId ? Number(v.userId) : null,
        ticketId: v.target === 'ticket' ? v.ticketId : null,
        projectTaskId: v.target === 'task' ? v.projectTaskId : null,
      });
    },
    onSuccess: () => {
      toast.success(entry ? 'Time entry updated' : 'Time logged');
      qc.invalidateQueries({ queryKey: ['time-entries'] });
      qc.invalidateQueries({ queryKey: ['time-week'] });
      qc.invalidateQueries({ queryKey: ['ticket'] });
      qc.invalidateQueries({ queryKey: ['project'] });
      qc.invalidateQueries({ queryKey: ['contract'] });
      onOpenChange(false);
      onSaved?.();
    },
    onError: (e) => handleFormError(e, setError),
  });

  const err = (k: keyof FormValues) => formState.errors[k]?.message as string | undefined;
  const submit = handleSubmit((v) => save.mutate(v));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={entry ? 'Edit time entry' : 'Log time'}
      size="md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {entry ? 'Save changes' : 'Log time'}
          </Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        {entry ? (
          <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px]">
            <div className="text-[11px] font-medium uppercase tracking-wide text-subtle">Logged against</div>
            {entry.ticketId ? (
              <TicketLink ticketId={entry.ticketId} className="text-primary hover:underline">
                {entry.ticketNumber} {entry.ticketTitle}
              </TicketLink>
            ) : (
              <Link to={`/projects/${entry.projectId}`} className="text-primary hover:underline">
                {entry.taskTitle} · {entry.projectName}
              </Link>
            )}
            <span className="ml-2 text-muted">{entry.companyName}</span>
          </div>
        ) : (
          <>
            <div className="inline-flex rounded-md border border-border-strong p-0.5">
              {(['ticket', 'task'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setValue('target', t)}
                  className={cn('cursor-pointer rounded px-3 py-1 text-xs font-medium', target === t ? 'bg-primary text-primary-fg' : 'text-muted hover:text-foreground')}
                >
                  {t === 'ticket' ? 'Ticket' : 'Project task'}
                </button>
              ))}
            </div>
            {target === 'ticket' ? (
              <FormField label="Ticket" required error={err('ticketId')}>
                <Controller
                  control={control}
                  name="ticketId"
                  render={({ field }) => <EntityPicker kind="ticket" value={field.value} onChange={field.onChange} label={defaults?.ticketLabel} invalid={!!err('ticketId')} placeholder="Search ticket number or title…" />}
                />
              </FormField>
            ) : (
              <FormField label="Project task" required error={err('projectTaskId') ?? err('ticketId')}>
                <Controller
                  control={control}
                  name="projectTaskId"
                  render={({ field }) => <EntityPicker kind="task" value={field.value} onChange={field.onChange} label={defaults?.taskLabel} filter={{ open: 'true' }} placeholder="Search task or project…" />}
                />
              </FormField>
            )}
          </>
        )}
        <FormGrid>
          {!entry && can('time.write_all') && (
            <FormField label="Resource" error={err('userId')}>
              <Select {...register('userId')} options={userOpts(lookups.data?.users, me?.user.id, false)} />
            </FormField>
          )}
          <FormField label="Work type" error={err('workTypeId')}>
            <Select
              {...register('workTypeId', {
                onChange: (e) => {
                  const wt = byId(lookups.data?.workTypes, Number(e.target.value));
                  if (wt) setValue('billable', wt.isBillable);
                },
              })}
              placeholder="—"
              options={opts(lookups.data?.workTypes, entry?.workTypeId)}
            />
          </FormField>
          <FormField label="Start" required error={err('startedAt')}>
            <Input type="datetime-local" {...register('startedAt')} aria-invalid={!!err('startedAt')} />
          </FormField>
          <FormField label="Duration (minutes)" required error={err('durationMinutes')} hint={duration ? `${Math.floor(duration / 60)}h ${duration % 60}m` : undefined}>
            <Input type="number" min="1" max="1440" step="1" {...register('durationMinutes')} aria-invalid={!!err('durationMinutes')} />
          </FormField>
        </FormGrid>
        <div className="-mt-1 flex flex-wrap gap-1">
          {QUICK.map((m) => (
            <Button key={m} size="sm" variant={duration === m ? 'primary' : 'subtle'} onClick={() => setValue('durationMinutes', String(m))}>
              {m < 60 ? `${m}m` : `${m / 60}h`}
            </Button>
          ))}
        </div>
        <Checkbox label="Billable" {...register('billable')} />
        <FormField label="Description" required error={err('description')} hint="Visible on invoices and customer reports">
          <Textarea rows={3} {...register('description')} aria-invalid={!!err('description')} />
        </FormField>
        <FormField label="Internal notes" error={err('internalNotes')}>
          <Textarea rows={2} {...register('internalNotes')} />
        </FormField>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

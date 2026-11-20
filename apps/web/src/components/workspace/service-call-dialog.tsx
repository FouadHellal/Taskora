import { useEffect, useMemo, useState } from 'react';

import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2, X } from 'lucide-react';
import { SERVICE_CALL_STATUS } from '@taskora/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useLookups } from '@/lib/lookups';
import { toLocalInput } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { ConfirmDialog, Dialog } from '@/components/ui/overlays';
import { Avatar, Badge, type Tone } from '@/components/ui/misc';
import { FormField, FormGrid, handleFormError } from '@/components/form';
import { EntityPicker } from '@/components/entity-picker';
import { TicketLink } from '@/lib/open-ticket';

export interface ServiceCall {
  id: number;
  title: string;
  description: string | null;
  companyId: number;
  companyName: string;
  startAt: string;
  endAt: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  createdById: number | null;
  users: { id: number; name: string }[];
  tickets: { id: number; ticketNumber: string; title: string }[];
}

export const SERVICE_CALL_TONE: Record<string, Tone> = {
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'neutral',
};

export function ServiceCallStatusBadge({ status }: { status: string }) {
  return <Badge tone={SERVICE_CALL_TONE[status] ?? 'neutral'}>{SERVICE_CALL_STATUS.labels[status as keyof typeof SERVICE_CALL_STATUS.labels] ?? status}</Badge>;
}

interface FormValues {
  title: string;
  description: string;
  companyId: number | null;
  startAt: string;
  endAt: string;
  status: ServiceCall['status'];
  userIds: number[];
}

export interface ServiceCallDefaults {
  startAt?: Date;
  endAt?: Date;
  companyId?: number | null;
  companyName?: string | null;
  userIds?: number[];
  tickets?: { id: number; label: string }[];
}

function roundedNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

/**
 * Create / edit dialog for service calls (scheduled on-site or remote
 * appointments). Used by the calendar and the service call list.
 */
export function ServiceCallDialog({
  open,
  onOpenChange,
  call,
  defaults,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  call?: ServiceCall | null;
  defaults?: ServiceCallDefaults;
  onSaved?: (c: ServiceCall) => void;
}) {
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const lookups = useLookups();
  const canWrite = can('tickets.write');
  const [tickets, setTickets] = useState<{ id: number; label: string }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const form = useForm<FormValues>();
  const { register, handleSubmit, reset, setError, control, formState, watch, setValue } = form;
  const companyId = watch('companyId');

  useEffect(() => {
    if (!open) return;
    if (call) {
      reset({
        title: call.title,
        description: call.description ?? '',
        companyId: call.companyId,
        startAt: toLocalInput(call.startAt),
        endAt: toLocalInput(call.endAt),
        status: call.status,
        userIds: call.users.map((u) => u.id),
      });
      setTickets(call.tickets.map((t) => ({ id: t.id, label: `${t.ticketNumber} ${t.title}` })));
    } else {
      const start = defaults?.startAt ?? roundedNow();
      const end = defaults?.endAt ?? new Date(start.getTime() + 60 * 60_000);
      reset({
        title: '',
        description: '',
        companyId: defaults?.companyId ?? null,
        startAt: toLocalInput(start),
        endAt: toLocalInput(end),
        status: 'scheduled',
        userIds: defaults?.userIds ?? (me?.user.isTechnician ? [me.user.id] : []),
      });
      setTickets(defaults?.tickets ?? []);
    }
  }, [open, call, defaults, reset, me]);

  const technicians = useMemo(
    () => (lookups.data?.users ?? []).filter((u) => (u.isActive && u.isTechnician) || call?.users.some((x) => x.id === u.id)),
    [lookups.data, call],
  );

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = {
        title: v.title,
        description: v.description || null,
        companyId: v.companyId,
        startAt: v.startAt ? new Date(v.startAt).toISOString() : '',
        endAt: v.endAt ? new Date(v.endAt).toISOString() : '',
        status: v.status,
        userIds: v.userIds,
        ticketIds: tickets.map((t) => t.id),
      };
      return call ? api.put<ServiceCall>(`/service-calls/${call.id}`, body) : api.post<ServiceCall>('/service-calls', body);
    },
    onSuccess: (row) => {
      toast.success(call ? 'Service call updated' : 'Service call scheduled');
      qc.invalidateQueries({ queryKey: ['service-calls'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      onOpenChange(false);
      onSaved?.(row);
    },
    onError: (e) => handleFormError(e, setError),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/service-calls/${call!.id}`),
    onSuccess: () => {
      toast.success('Service call deleted');
      qc.invalidateQueries({ queryKey: ['service-calls'] });
      qc.invalidateQueries({ queryKey: ['calendar'] });
      qc.invalidateQueries({ queryKey: ['my-work'] });
      setConfirmDelete(false);
      onOpenChange(false);
    },
    onError: (e) => handleFormError(e),
  });

  const err = (k: keyof FormValues) => formState.errors[k]?.message as string | undefined;
  const submit = handleSubmit((v) => {
    if (!v.companyId) {
      setError('companyId', { message: 'Required' });
      return;
    }
    save.mutate(v);
  });

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={call ? (canWrite ? 'Edit service call' : call.title) : 'New service call'}
        description={call ? `Created for ${call.companyName}` : 'Schedule technicians for on-site or remote work'}
        size="lg"
        footer={
          <>
            {call && canWrite && (
              <Button variant="ghost" className="mr-auto text-danger" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete
              </Button>
            )}
            <Button onClick={() => onOpenChange(false)}>{canWrite ? 'Cancel' : 'Close'}</Button>
            {canWrite && (
              <Button variant="primary" loading={save.isPending} onClick={submit}>
                {call ? 'Save changes' : 'Schedule'}
              </Button>
            )}
          </>
        }
      >
        <form className="space-y-4" onSubmit={submit}>
          <fieldset disabled={!canWrite} className="space-y-4">
            <FormGrid cols={3}>
              <FormField label="Title" required error={err('title')} className="sm:col-span-2">
                <Input {...register('title')} placeholder="e.g. On-site printer replacement" aria-invalid={!!err('title')} />
              </FormField>
              <FormField label="Status">
                <Select {...register('status')} options={SERVICE_CALL_STATUS.values.map((v) => ({ value: v, label: SERVICE_CALL_STATUS.labels[v] }))} />
              </FormField>
            </FormGrid>
            <FormGrid cols={3}>
              <FormField label="Company" required error={err('companyId')}>
                <Controller
                  control={control}
                  name="companyId"
                  render={({ field }) => (
                    <EntityPicker
                      kind="company"
                      value={field.value}
                      label={call?.companyId === field.value ? call?.companyName : field.value === defaults?.companyId ? defaults?.companyName : undefined}
                      invalid={!!err('companyId')}
                      disabled={!canWrite}
                      onChange={(id) => {
                        if (id !== field.value) setTickets([]);
                        field.onChange(id);
                      }}
                    />
                  )}
                />
              </FormField>
              <FormField label="Start" required error={err('startAt')}>
                <Input
                  type="datetime-local"
                  {...register('startAt', {
                    onChange: (e) => {
                      // Push the end forward when the start moves past it.
                      const s = new Date(e.target.value);
                      const end = new Date(watch('endAt'));
                      if (!Number.isNaN(s.getTime()) && (Number.isNaN(end.getTime()) || end <= s)) {
                        setValue('endAt', toLocalInput(new Date(s.getTime() + 60 * 60_000)));
                      }
                    },
                  })}
                />
              </FormField>
              <FormField label="End" required error={err('endAt')}>
                <Input type="datetime-local" {...register('endAt')} aria-invalid={!!err('endAt')} />
              </FormField>
            </FormGrid>

            <FormField label="Technicians" hint="Assigned technicians are notified and see the call in their calendar.">
              <Controller
                control={control}
                name="userIds"
                render={({ field }) => (
                  <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto rounded-md border border-border-strong p-2 sm:grid-cols-3">
                    {technicians.length === 0 && <span className="text-xs text-muted">No technicians available.</span>}
                    {technicians.map((u) => {
                      const checked = (field.value ?? []).includes(u.id);
                      const name = `${u.firstName} ${u.lastName}`;
                      return (
                        <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-surface-2">
                          <input
                            type="checkbox"
                            className="size-3.5 accent-[var(--primary)]"
                            checked={checked}
                            onChange={(e) => field.onChange(e.target.checked ? [...(field.value ?? []), u.id] : (field.value ?? []).filter((x) => x !== u.id))}
                          />
                          <Avatar name={name} className="size-5 text-[9px]" />
                          <span className="truncate">{name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              />
            </FormField>

            <FormField label="Tickets" hint={companyId ? 'Only tickets of the selected company can be linked.' : 'Select a company first.'}>
              <div className="space-y-1.5">
                {tickets.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 rounded-md border border-border bg-surface-2/50 px-2 py-1 text-[13px]">
                    <TicketLink ticketId={t.id} className="min-w-0 flex-1 truncate hover:text-primary" onClick={() => onOpenChange(false)}>
                      {t.label}
                    </TicketLink>
                    {canWrite && (
                      <button type="button" className="cursor-pointer rounded p-0.5 text-muted hover:text-danger" onClick={() => setTickets((ts) => ts.filter((x) => x.id !== t.id))} aria-label="Remove ticket">
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {canWrite && (
                  <EntityPicker
                    kind="ticket"
                    value={null}
                    disabled={!companyId}
                    filter={{ companyId, statusCategory: 'open' }}
                    placeholder="Add a ticket…"
                    onChange={(id, o) => {
                      if (id && o && !tickets.some((t) => t.id === id)) setTickets((ts) => [...ts, { id, label: o.label }]);
                    }}
                  />
                )}
              </div>
            </FormField>

            <FormField label="Description">
              <Textarea rows={3} {...register('description')} placeholder="What needs to be done, access instructions…" />
            </FormField>
          </fieldset>
          <button type="submit" hidden />
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete service call?"
        description={`"${call?.title}" will be removed from all technicians' calendars.`}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

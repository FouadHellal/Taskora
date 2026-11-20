import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { opts, useLookups } from '@/lib/lookups';
import { toLocalInput } from '@/lib/utils';
import { Button } from '../ui/button';
import { Checkbox, Input, Select } from '../ui/input';
import { Dialog } from '../ui/overlays';
import { FormField, FormGrid, handleFormError } from '../form';
import { ImageTextarea } from './image-paste';
import type { TicketTimeEntry } from './ticket-types';

/** Quick time entry against a ticket (or project task); with `entry`, edits that entry. */
export function LogTimeDialog({
  open,
  onOpenChange,
  ticketId,
  projectTaskId,
  defaultDescription = '',
  entry,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ticketId?: number;
  projectTaskId?: number;
  defaultDescription?: string;
  entry?: TicketTimeEntry | null;
}) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const [startedAt, setStartedAt] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [workTypeId, setWorkTypeId] = useState('');
  const [billable, setBillable] = useState(true);
  const [description, setDescription] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setErrors({});
    if (entry) {
      setStartedAt(toLocalInput(entry.startedAt));
      setMinutes(String(entry.durationMinutes));
      setDescription(entry.description);
      setInternalNotes(entry.internalNotes ?? '');
      setWorkTypeId(entry.workTypeId ? String(entry.workTypeId) : '');
      setBillable(entry.billable);
      return;
    }
    setStartedAt(toLocalInput(new Date(Date.now() - 30 * 60_000)));
    setMinutes('30');
    setDescription(defaultDescription);
    setInternalNotes('');
    const def = lookups.data?.workTypes.find((w) => w.isActive !== false);
    setWorkTypeId(def ? String(def.id) : '');
    setBillable(def?.isBillable ?? true);
  }, [open, defaultDescription, lookups.data, entry]);

  const save = useMutation({
    mutationFn: () => {
      const fields = {
        startedAt: new Date(startedAt).toISOString(),
        durationMinutes: Number(minutes),
        workTypeId: workTypeId ? Number(workTypeId) : null,
        billable,
        description,
        internalNotes: internalNotes || null,
      };
      return entry ? api.patch(`/time-entries/${entry.id}`, fields) : api.post('/time-entries', { ticketId: ticketId ?? null, projectTaskId: projectTaskId ?? null, ...fields });
    },
    onSuccess: () => {
      toast.success(entry ? 'Time entry updated' : 'Time logged');
      qc.invalidateQueries({ queryKey: ['ticket'] });
      qc.invalidateQueries({ queryKey: ['timeline'] });
      qc.invalidateQueries({ queryKey: ['time-entries'] });
      qc.invalidateQueries({ queryKey: ['project'] });
      onOpenChange(false);
    },
    onError: (e) => handleFormError(e, (name: string, err: { message: string }) => setErrors((x) => ({ ...x, [name]: err.message }))),
  });

  const uploading = Object.values(busy).some(Boolean);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={entry ? 'Edit time entry' : 'Log time'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!description.trim() || !Number(minutes) || uploading} onClick={() => save.mutate()}>
            {entry ? 'Save changes' : 'Save time entry'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormGrid cols={2}>
          <FormField label="Start" error={errors.startedAt}>
            <Input type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
          </FormField>
          <FormField label="Duration (minutes)" error={errors.durationMinutes}>
            <div className="flex gap-1">
              <Input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="w-24" />
              {[15, 30, 60, 90].map((m) => (
                <Button key={m} size="sm" variant={Number(minutes) === m ? 'primary' : 'secondary'} className="h-8" onClick={() => setMinutes(String(m))}>
                  {m < 60 ? `${m}m` : `${m / 60}h`}
                </Button>
              ))}
            </div>
          </FormField>
          <FormField label="Work type">
            <Select
              value={workTypeId}
              onChange={(e) => {
                setWorkTypeId(e.target.value);
                const w = lookups.data?.workTypes.find((x) => x.id === Number(e.target.value));
                if (w) setBillable(w.isBillable);
              }}
              placeholder="—"
              options={opts(lookups.data?.workTypes, entry?.workTypeId)}
            />
          </FormField>
          <div className="flex items-end pb-2">
            <Checkbox label="Billable" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
          </div>
        </FormGrid>
        <FormField label="Work performed" required error={errors.description} hint="Shown on invoices for billable time">
          <ImageTextarea ticketId={ticketId} rows={4} value={description} onValueChange={setDescription} onBusyChange={(b) => setBusy((x) => ({ ...x, description: b }))} />
        </FormField>
        <FormField label="Internal notes">
          <ImageTextarea ticketId={ticketId} rows={2} value={internalNotes} onValueChange={setInternalNotes} onBusyChange={(b) => setBusy((x) => ({ ...x, internalNotes: b }))} hint={false} />
        </FormField>
      </div>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TicketLink } from '@/lib/open-ticket';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useLookups, opts } from '@/lib/lookups';
import { Button } from '../ui/button';
import { Checkbox, Select, Textarea } from '../ui/input';
import { Dialog } from '../ui/overlays';
import { FormField, handleFormError } from '../form';

export interface ActiveTimer {
  id: number;
  ticketId: number | null;
  projectTaskId: number | null;
  startedAt: string;
  description: string | null;
  ticketNumber: string | null;
  ticketTitle: string | null;
  taskTitle: string | null;
}

export function useTimer() {
  return useQuery({ queryKey: ['timer'], queryFn: () => api.get<ActiveTimer | null>('/timer'), refetchInterval: 60_000 });
}

export function elapsedLabel(startedAt: string, now: number) {
  const secs = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Shows the running timer in the top bar; stopping it opens a time-entry form. */
export function TimerWidget() {
  const timer = useTimer();
  const [now, setNow] = useState(Date.now());
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!timer.data) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer.data]);
  if (!timer.data) return null;
  const t = timer.data;
  return (
    <>
      <div className="flex h-8 items-center gap-1 rounded-md border border-primary/30 bg-primary-soft pl-2 text-[12px] text-primary">
        <Timer className="size-3.5 animate-pulse" />
        {t.ticketId ? (
          <TicketLink ticketId={t.ticketId} className="max-w-40 truncate font-medium hover:underline">
            {t.ticketNumber ?? 'Timer'}
          </TicketLink>
        ) : (
          <Link to="/time" className="max-w-40 truncate font-medium hover:underline">
            {t.taskTitle ?? 'Timer'}
          </Link>
        )}
        <span className="font-mono tabular-nums">{elapsedLabel(t.startedAt, now)}</span>
        <Button size="icon-sm" variant="ghost" className="text-primary" onClick={() => setStopping(true)} aria-label="Stop timer">
          <Pause />
        </Button>
      </div>
      <StopTimerDialog open={stopping} onOpenChange={setStopping} timer={t} />
    </>
  );
}

export function StopTimerDialog({ open, onOpenChange, timer }: { open: boolean; onOpenChange: (o: boolean) => void; timer: ActiveTimer }) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const [description, setDescription] = useState(timer.description ?? '');
  const [workTypeId, setWorkTypeId] = useState('');
  const [billable, setBillable] = useState(true);
  const stop = useMutation({
    mutationFn: () => api.post('/timer/stop', { description, workTypeId: workTypeId ? Number(workTypeId) : null, billable }),
    onSuccess: () => {
      toast.success('Time entry saved');
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ['timer'] });
      qc.invalidateQueries({ queryKey: ['time-entries'] });
      qc.invalidateQueries({ queryKey: ['ticket'] });
      qc.invalidateQueries({ queryKey: ['timeline'] });
    },
    onError: (e) => handleFormError(e),
  });
  const discard = useMutation({
    mutationFn: () => api.delete('/timer'),
    onSuccess: () => {
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ['timer'] });
      toast('Timer discarded');
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stop timer and log time"
      description={`${timer.ticketNumber ? `${timer.ticketNumber} · ${timer.ticketTitle}` : (timer.taskTitle ?? '')} — ${elapsedLabel(timer.startedAt, Date.now())}`}
      footer={
        <>
          <Button variant="ghost" className="mr-auto text-danger" onClick={() => discard.mutate()} loading={discard.isPending}>
            <Trash2 /> Discard
          </Button>
          <Button onClick={() => onOpenChange(false)}>Keep running</Button>
          <Button variant="primary" disabled={!description.trim()} loading={stop.isPending} onClick={() => stop.mutate()}>
            Save time entry
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Work performed" required>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Describe what you did…" />
        </FormField>
        <div className="grid grid-cols-2 items-end gap-3">
          <FormField label="Work type">
            <Select value={workTypeId} onChange={(e) => setWorkTypeId(e.target.value)} placeholder="Default" options={opts(lookups.data?.workTypes)} />
          </FormField>
          <Checkbox label="Billable" checked={billable} onChange={(e) => setBillable(e.target.checked)} className="pb-2" />
        </div>
      </div>
    </Dialog>
  );
}

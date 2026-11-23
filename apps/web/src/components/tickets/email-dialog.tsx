import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Paperclip, Send } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { opts, useLookups } from '@/lib/lookups';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { Dialog } from '@/components/ui/overlays';
import { FormField, handleFormError } from '@/components/form';
import type { TicketDetail } from './ticket-types';
import { ImageTextarea } from './image-paste';

interface Draft {
  enabled: boolean;
  from: string | null;
  to: string[];
  subject: string;
  body: string;
  signature: string;
  signatureHtml?: string;
}

interface AttachmentRow {
  id: number;
  fileName: string;
  sizeBytes: number;
}

const split = (v: string) =>
  v
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);

/** Compose and send an e-mail from a ticket (recorded as a customer-visible note). */
export function SendEmailDialog({ ticket, open, onOpenChange, onSent }: { ticket: TicketDetail; open: boolean; onOpenChange: (o: boolean) => void; onSent: () => void }) {
  const { can } = useAuth();
  const lookups = useLookups();
  const draft = useQuery({ queryKey: ['ticket-email-draft', ticket.id], queryFn: () => api.get<Draft>(`/tickets/${ticket.id}/email/draft`), enabled: open, staleTime: 0 });
  const files = useQuery({ queryKey: ['attachments', 'ticket', ticket.id], queryFn: () => api.get<{ data: AttachmentRow[] }>(`/attachments/ticket/${ticket.id}`), enabled: open });
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attach, setAttach] = useState<number[]>([]);
  const [saveAsNote, setSaveAsNote] = useState(true);
  const [statusId, setStatusId] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open || !draft.data) return;
    setTo(draft.data.to.join(', '));
    setCc('');
    setBcc('');
    setSubject(draft.data.subject);
    setBody(draft.data.body);
    setAttach([]);
    setStatusId('');
    setSaveAsNote(true);
  }, [open, draft.data]);

  const send = useMutation({
    mutationFn: () =>
      api.post<{ to: string[] }>(`/tickets/${ticket.id}/email`, {
        to: split(to),
        cc: split(cc),
        bcc: split(bcc),
        subject,
        body,
        attachmentIds: attach,
        saveAsNote,
        statusId: statusId ? Number(statusId) : null,
      }),
    onSuccess: (r) => {
      toast.success(`E-mail sent to ${r.to.join(', ')}`);
      onOpenChange(false);
      onSent();
    },
    onError: (e) => handleFormError(e),
  });

  const d = draft.data;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`E-mail · ${ticket.ticketNumber}`}
      description={d?.from ? `From ${d.from}` : undefined}
      size="lg"
      footer={
        d?.enabled ? (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={send.isPending} disabled={!split(to).length || !subject.trim() || !body.trim() || uploading} onClick={() => send.mutate()}>
              <Send /> Send
            </Button>
          </>
        ) : undefined
      }
    >
      {!d ? (
        <p className="py-6 text-center text-xs text-muted">Loading…</p>
      ) : !d.enabled ? (
        <div className="space-y-2 py-4 text-[13px]">
          <p>Outgoing e-mail is not configured yet.</p>
          {can('settings.manage') ? (
            <Link to="/admin/email" className="text-primary hover:underline" onClick={() => onOpenChange(false)}>
              Configure SMTP in Administration → E-mail
            </Link>
          ) : (
            <p className="text-muted">Ask an administrator to configure it in Administration → E-mail.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <FormField label="To" required hint="Separate several addresses with commas">
            <div className="flex gap-2">
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" />
              {!showBcc && (
                <Button size="sm" variant="ghost" onClick={() => setShowBcc(true)}>
                  Bcc
                </Button>
              )}
            </div>
          </FormField>
          <FormField label="Cc">
            <Input value={cc} onChange={(e) => setCc(e.target.value)} />
          </FormField>
          {showBcc && (
            <FormField label="Bcc">
              <Input value={bcc} onChange={(e) => setBcc(e.target.value)} />
            </FormField>
          )}
          <FormField label="Subject" required hint="The ticket number keeps replies threaded into this ticket">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </FormField>
          <FormField label="Message" required>
            <ImageTextarea ticketId={ticket.id} rows={10} value={body} onValueChange={setBody} onBusyChange={setUploading} />
          </FormField>
          {d.signatureHtml ? (
            <div>
              <div className="mb-1 text-[11px] text-muted">Signature (added automatically)</div>
              <iframe title="Signature" sandbox="" srcDoc={`<body style="margin:0;font-family:Arial,sans-serif">${d.signatureHtml}</body>`} className="h-36 w-full rounded-md border border-border bg-white" />
            </div>
          ) : (
            d.signature && (
              <pre className="whitespace-pre-wrap rounded-md bg-surface-2 px-3 py-2 font-sans text-xs text-muted">
                {'-- \n'}
                {d.signature}
              </pre>
            )
          )}
          {!!files.data?.data.length && (
            <FormField label="Attach files from this ticket">
              <div className="grid gap-1 sm:grid-cols-2">
                {files.data.data.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={attach.includes(f.id)}
                      onChange={(e) => setAttach((a) => (e.target.checked ? [...a, f.id] : a.filter((x) => x !== f.id)))}
                    />
                    <Paperclip className="size-3 text-muted" />
                    <span className="truncate">{f.fileName}</span>
                    <span className="text-subtle">{Math.max(1, Math.round(f.sizeBytes / 1024))} KB</span>
                  </label>
                ))}
              </div>
            </FormField>
          )}
          <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
            <Checkbox label="Save as customer-visible note" checked={saveAsNote} onChange={(e) => setSaveAsNote(e.target.checked)} />
            {saveAsNote && (
              <div className="w-52">
                <Select value={statusId} onChange={(e) => setStatusId(e.target.value)} placeholder="Keep status" options={opts(lookups.data?.statuses).filter((o) => o.value !== ticket.statusId)} className="h-7" />
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

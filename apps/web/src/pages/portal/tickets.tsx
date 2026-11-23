import { useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Circle, Clock, Download, FileText, Hourglass, Inbox, Paperclip, Plus, Search, Send, Upload, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { translate as t } from '@/lib/i18n';
import { cn, fmtDate, fmtDateTime, fmtRelative } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/input';
import { Card, CardBody, CardHeader, EmptyState, PageLoader } from '@/components/ui/misc';
import { PriorityBadge, StatusBadge } from '@/components/badges';
import { NoteBody } from '@/components/tickets/note-body';
import { fmtBytes, fmtMinutes, papi, PORTAL_IMAGES, STATE_LABEL, type Me, type PTicket, type PTicketDetail } from './lib';

export default function PortalTickets({ me }: { me: Me }) {
  return (
    <Routes>
      <Route index element={<TicketList me={me} />} />
      <Route path="new" element={<NewRequest me={me} />} />
      <Route path=":id" element={<TicketView me={me} />} />
    </Routes>
  );
}

/* ----------------------------------------------------------------- list */

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'waiting', label: 'Waiting for you' },
  { key: 'closed', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

function TicketList({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const state = params.get('state') ?? 'open';
  const [search, setSearch] = useState('');
  const c = me.contact!;
  const q = useQuery({ queryKey: ['portal-tickets', state, search], queryFn: () => papi<{ data: PTicket[] }>('GET', `/tickets?state=${state}&q=${encodeURIComponent(search)}`) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{c.isManager ? t('Tickets of {company}', { company: c.companyName }) : t('My tickets')}</h1>
          <p className="text-[12px] text-muted">{c.isManager ? t('Every request of your company.') : t('The requests you opened.')}</p>
        </div>
        <Button variant="primary" onClick={() => navigate('/portal/tickets/new')}>
          <Plus /> New request
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setParams(f.key === 'open' ? {} : { state: f.key })}
              className={cn('cursor-pointer rounded-md px-2.5 py-1 text-[12px] text-muted hover:text-foreground', state === f.key && 'bg-primary-soft font-medium text-primary')}
            >
              {t(f.label)}
            </button>
          ))}
        </div>
        <div className="relative min-w-48 flex-1 sm:max-w-72 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title or number…" className="pl-8" />
        </div>
      </div>
      <Card>
        {q.isLoading ? (
          <PageLoader />
        ) : !q.data?.data.length ? (
          <EmptyState icon={<Inbox />} title={search ? 'No ticket matches your search' : 'No tickets here'} description={state === 'open' ? 'Need help? Use “New request”.' : undefined} />
        ) : (
          <ul className="divide-y divide-border">
            {q.data.data.map((tk) => (
              <li key={tk.id}>
                <Link to={`/portal/tickets/${tk.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2 sm:flex-nowrap">
                  <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                    <div className="truncate text-[14px] font-medium sm:text-[13px]">{tk.title}</div>
                    <div className="truncate text-[11px] text-muted">
                      <span className="font-mono">{tk.ticketNumber}</span> · {t('opened {when}', { when: fmtDate(tk.createdAt) })}
                      {c.isManager && tk.contactName ? ` · ${tk.contactName}` : ''}
                      {tk.assignedName ? ` · ${t('handled by {name}', { name: tk.assignedName })}` : ''}
                    </div>
                  </div>
                  {me.features?.time && tk.workedMinutes > 0 && (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                      <Clock className="size-3" /> {fmtMinutes(tk.workedMinutes)}
                    </span>
                  )}
                  <StatusBadge name={tk.statusName} color={tk.statusColor} />
                  <span className="ml-auto text-right text-[11px] text-muted sm:ml-0 sm:w-24">{fmtRelative(tk.lastActivityAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------ new request */

function FilePicker({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onChange([...files, ...Array.from(e.dataTransfer.files)]);
        }}
        onClick={() => input.current?.click()}
        className={cn('flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border-strong px-3 py-4 text-[12px] text-muted hover:bg-surface-2', over && 'border-primary bg-primary-soft/40')}
      >
        <Upload className="size-4" /> {t('Drop files here or click to choose (screenshots, error messages…)')}
      </div>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onChange([...files, ...Array.from(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded border border-border px-2 py-1 text-[12px]">
              <Paperclip className="size-3 text-muted" /> <span className="min-w-0 flex-1 truncate">{f.name}</span> <span className="text-muted">{fmtBytes(f.size)}</span>
              <button className="cursor-pointer text-muted hover:text-danger" aria-label={t('Remove')} onClick={() => onChange(files.filter((_, j) => j !== i))}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function uploadFiles(ticketId: number, files: File[]) {
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name || 'pasted-image.png');
  await papi('POST', `/tickets/${ticketId}/files`, fd);
}

/** Pasted screenshots become attachments. */
function pastedFiles(e: React.ClipboardEvent): File[] {
  return Array.from(e.clipboardData.files ?? []).map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${Date.now()}-${i + 1}.png`, { type: f.type })));
}

function NewRequest({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const f = me.features!;
  const opts = useQuery({ queryKey: ['portal-options'], queryFn: () => papi<{ priorities: { id: number; name: string; color: string | null; isDefault: boolean }[]; devices: { id: number; name: string; typeName: string | null; mine: boolean }[] }>('GET', '/options') });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priorityId, setPriorityId] = useState<number | null>(null);
  const [params] = useSearchParams();
  const [deviceId, setDeviceId] = useState(params.get('device') ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const defaultPriority = opts.data?.priorities.find((p) => p.isDefault)?.id ?? null;
  const chosenPriority = priorityId ?? defaultPriority;

  const create = useMutation({
    mutationFn: async () => {
      const tk = await papi<{ id: number; ticketNumber: string }>('POST', '/tickets', {
        title,
        description,
        priorityId: f.priority ? chosenPriority : null,
        configurationItemId: deviceId ? Number(deviceId) : null,
      });
      try {
        await uploadFiles(tk.id, files);
      } catch (e) {
        toast.error(t('The request was created but a file could not be attached: {error}', { error: (e as Error).message }));
      }
      return tk;
    },
    onSuccess: (tk) => {
      toast.success(t('Request {number} created — we will get back to you soon.', { number: tk.ticketNumber }));
      qc.invalidateQueries({ queryKey: ['portal-tickets'] });
      qc.invalidateQueries({ queryKey: ['portal-dashboard'] });
      navigate(`/portal/tickets/${tk.id}`, { replace: true });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link to="/portal/tickets" className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <ArrowLeft className="size-3" /> {t('Back to tickets')}
      </Link>
      <div>
        <h1 className="text-lg font-semibold">{t('New request')}</h1>
        <p className="text-[13px] text-muted">{t('Tell us what is going on. The more details, the faster we can help.')}</p>
      </div>
      <Card>
        <CardBody className="space-y-4">
          <div>
            <Label htmlFor="rq-title">{t('Subject')}</Label>
            <Input id="rq-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary, e.g. “Outlook does not open”" autoFocus maxLength={255} />
          </div>
          <div>
            <Label htmlFor="rq-desc">{t('Description')}</Label>
            <Textarea
              id="rq-desc"
              rows={7}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onPaste={(e) => {
                const pasted = pastedFiles(e);
                if (pasted.length && f.attachments) {
                  e.preventDefault();
                  setFiles((x) => [...x, ...pasted]);
                  toast.success(t('Screenshot added as an attachment'));
                }
              }}
              placeholder="What happens? Since when? Who is affected? Any error message?"
            />
          </div>
          {f.priority && opts.data && opts.data.priorities.length > 0 && (
            <div>
              <Label>{t('How urgent is it?')}</Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {opts.data.priorities.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPriorityId(p.id)}
                    className={cn(
                      'flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px]',
                      chosenPriority === p.id ? 'border-primary bg-primary-soft font-medium text-primary' : 'border-border hover:border-border-strong',
                    )}
                  >
                    <span className="inline-block size-2 rounded-full" style={{ backgroundColor: p.color ?? 'var(--subtle)' }} /> {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {f.devices && opts.data && opts.data.devices.length > 0 && (
            <div>
              <Label htmlFor="rq-dev">{t('Which device? (optional)')}</Label>
              <Select id="rq-dev" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">{t('Not about a specific device')}</option>
                {opts.data.devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.typeName ? ` — ${d.typeName}` : ''}
                    {d.mine ? ` (${t('yours')})` : ''}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {f.attachments && (
            <div>
              <Label>{t('Attachments (optional)')}</Label>
              <FilePicker files={files} onChange={setFiles} />
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button variant="primary" size="lg" disabled={title.trim().length < 3} loading={create.isPending} onClick={() => create.mutate()}>
              <Send /> Send request
            </Button>
            <Button size="lg" variant="ghost" onClick={() => navigate('/portal/tickets')}>
              Cancel
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- detail */

const STEPS = ['new', 'open', 'resolved'] as const;

function Progress({ category }: { category: string }) {
  const at = category === 'closed' || category === 'resolved' ? 2 : category === 'new' ? 0 : 1;
  return (
    <ol className="flex items-center gap-2 text-[11px]">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          {i > 0 && <span className={cn('h-px w-6 sm:w-10', i <= at ? 'bg-primary' : 'bg-border')} />}
          <span className={cn('inline-flex items-center gap-1', i <= at ? 'font-medium text-primary' : 'text-muted')}>
            {i < at || (i === at && at === 2) ? <CheckCircle2 className="size-3.5" /> : <Circle className={cn('size-3.5', i === at && 'fill-primary/20')} />}
            {t(i === 1 && category === 'waiting' ? STATE_LABEL.waiting! : STATE_LABEL[s]!)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function TicketView({ me }: { me: Me }) {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const f = me.features!;
  const [reply, setReply] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [showAttach, setShowAttach] = useState(false);
  const q = useQuery({ queryKey: ['portal-ticket', id], queryFn: () => papi<PTicketDetail>('GET', `/tickets/${id}`) });
  const send = useMutation({
    mutationFn: async () => {
      if (reply.trim()) await papi('POST', `/tickets/${id}/replies`, { body: reply });
      await uploadFiles(id, files);
    },
    onSuccess: () => {
      setReply('');
      setFiles([]);
      setShowAttach(false);
      qc.invalidateQueries({ queryKey: ['portal-ticket', id] });
      qc.invalidateQueries({ queryKey: ['portal-tickets'] });
      toast.success(t('Sent — the IT team has been notified'));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <EmptyState title="Ticket not found" description={(q.error as Error | null)?.message} />;
  const tk = q.data;
  const done = tk.statusCategory === 'resolved' || tk.statusCategory === 'closed';

  return (
    <div className="space-y-4">
      <Link to="/portal/tickets" className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <ArrowLeft className="size-3" /> {t('Back to tickets')}
      </Link>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted">{tk.ticketNumber}</span>
          <StatusBadge name={tk.statusName} color={tk.statusColor} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{tk.title}</h1>
        <Progress category={tk.statusCategory} />
      </div>

      {tk.statusCategory === 'waiting' && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-[13px] text-warning">
          <Hourglass className="mt-0.5 size-4 shrink-0" /> {t('We are waiting for your answer. Reply below so we can continue.')}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {tk.resolution && (
            <Card className="border-success/40">
              <CardHeader title={<span className="inline-flex items-center gap-1.5 text-success"><CheckCircle2 className="size-4" /> {t('Solution')}</span>} />
              <CardBody>
                <NoteBody text={tk.resolution} allow={PORTAL_IMAGES} className="text-[13px]" />
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Conversation" />
            <CardBody className="space-y-3">
              <Message author={tk.contactName ?? t('You')} date={tk.createdAt} fromCustomer label={t('Request')}>
                {tk.description ? <NoteBody text={tk.description} allow={PORTAL_IMAGES} className="text-[13px]" /> : <span className="text-[13px] italic text-muted">{t('No description')}</span>}
              </Message>
              {tk.notes.map((n) => (
                <Message key={n.id} author={n.fromCustomer ? null : (n.author ?? t('IT team'))} date={n.createdAt} fromCustomer={n.fromCustomer}>
                  <NoteBody text={n.body} allow={PORTAL_IMAGES} className="text-[13px]" />
                </Message>
              ))}
            </CardBody>
            <div className="border-t border-border p-4">
              <Textarea
                rows={3}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onPaste={(e) => {
                  const pasted = pastedFiles(e);
                  if (pasted.length && f.attachments) {
                    e.preventDefault();
                    setFiles((x) => [...x, ...pasted]);
                    setShowAttach(true);
                  }
                }}
                placeholder={done ? t('Something is still wrong? Reply and we will reopen the ticket.') : t('Write a reply…')}
              />
              {showAttach && f.attachments && (
                <div className="mt-2">
                  <FilePicker files={files} onChange={setFiles} />
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button variant="primary" disabled={!reply.trim() && !files.length} loading={send.isPending} onClick={() => send.mutate()}>
                  <Send /> Send
                </Button>
                {f.attachments && !showAttach && (
                  <Button variant="ghost" onClick={() => setShowAttach(true)}>
                    <Paperclip /> Attach files
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {f.time && (
            <Card>
              <CardHeader title="Work done" actions={<span className="text-[12px] font-medium">{t('Total: {time}', { time: fmtMinutes(tk.workedMinutes) })}</span>} />
              {tk.timeEntries.length === 0 ? (
                <CardBody className="text-[13px] text-muted">{t('No time recorded on this ticket yet.')}</CardBody>
              ) : (
                <ul className="divide-y divide-border">
                  {tk.timeEntries.map((e) => (
                    <li key={e.id} className="flex gap-3 px-4 py-2.5 text-[13px]">
                      <div className="w-24 shrink-0 text-[12px] text-muted">{fmtDate(e.startedAt)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="whitespace-pre-wrap break-words">{e.description}</div>
                        {e.technician && <div className="text-[11px] text-muted">{e.technician}</div>}
                      </div>
                      <div className="shrink-0 font-medium tabular-nums">{fmtMinutes(e.minutes)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="space-y-2.5 text-[13px]">
                <Detail label="Status">
                  <StatusBadge name={tk.statusName} color={tk.statusColor} />
                </Detail>
                <Detail label="Priority">
                  <PriorityBadge name={tk.priorityName} color={tk.priorityColor} />
                </Detail>
                <Detail label="Opened by">{tk.contactName ?? '—'}</Detail>
                <Detail label="Opened on">{fmtDateTime(tk.createdAt)}</Detail>
                <Detail label="Handled by">
                  {tk.assignedName ? (
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="size-3.5 text-muted" /> {tk.assignedName}
                    </span>
                  ) : (
                    <span className="text-muted">{t('Not assigned yet')}</span>
                  )}
                </Detail>
                {tk.deviceName && <Detail label="Device">{tk.deviceName}</Detail>}
                {f.time && <Detail label="Time worked">{fmtMinutes(tk.workedMinutes)}</Detail>}
                {tk.resolvedAt && <Detail label="Resolved on">{fmtDateTime(tk.resolvedAt)}</Detail>}
                <Detail label="Last update">{fmtRelative(tk.lastActivityAt)}</Detail>
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Files" />
            {tk.files.length === 0 ? (
              <CardBody className="text-[13px] text-muted">{f.attachments ? t('No files yet. Add screenshots or documents with your reply.') : t('No files.')}</CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {tk.files.map((file) => (
                  <li key={file.id}>
                    <a href={`/api/portal/tickets/${tk.id}/files/${file.id}`} className="flex items-center gap-2 px-4 py-2 text-[12px] hover:bg-surface-2">
                      <FileText className="size-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{file.fileName}</span>
                        <span className="text-[11px] text-muted">
                          {fmtBytes(file.sizeBytes)} · {file.fromClient ? t('from you') : t('from the IT team')} · {fmtDate(file.createdAt)}
                        </span>
                      </span>
                      <Download className="size-3.5 text-muted" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted">{t(label)}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Message({ author, date, fromCustomer, label, children }: { author: string | null; date: string; fromCustomer: boolean; label?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border p-3', fromCustomer ? 'border-border bg-surface-2 sm:ml-10' : 'border-primary/30 bg-primary-soft/30 sm:mr-10')}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        <span className="font-medium text-foreground">{author ?? t('You or a colleague')}</span>
        {!fromCustomer && <span className="rounded bg-primary-soft px-1.5 py-px text-[10px] font-medium text-primary">{t('IT team')}</span>}
        {label && <span className="rounded bg-surface px-1.5 py-px text-[10px]">{label}</span>}
        <span>· {fmtDateTime(date)}</span>
      </div>
      {children}
    </div>
  );
}

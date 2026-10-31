import { useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, LogOut, Plus, Ticket } from 'lucide-react';
import { toast } from 'sonner';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Card, CardBody, CardHeader, EmptyState, PageLoader } from '@/components/ui/misc';
import { StatusBadge } from '@/components/badges';
import { Markdown } from '@/components/kb/markdown';

/* Minimal client for the separate portal API realm (own cookie + CSRF). */
let portalCsrf: string | null = null;
async function papi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/portal${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' && portalCsrf ? { 'x-csrf-token': portalCsrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? res.statusText);
  return data as T;
}

interface Me {
  contact: { firstName: string; lastName: string; email: string; companyName: string; seesCompanyTickets: boolean } | null;
  organizationName?: string;
  csrfToken?: string;
}

function usePortalMe() {
  return useQuery({
    queryKey: ['portal-me'],
    queryFn: async () => {
      const me = await papi<Me>('GET', '/me');
      portalCsrf = me.csrfToken ?? null;
      return me;
    },
    retry: false,
  });
}

function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex min-h-14 max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <Link to="/portal" className="flex min-w-0 items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="size-6 shrink-0" /> <span className="truncate">{me.organizationName} Support</span>
          </Link>
          <nav className="order-last flex w-full gap-1 text-[13px] sm:order-none sm:w-auto">
            <Link to="/portal" className="rounded px-2 py-1 hover:bg-surface-2">
              My tickets
            </Link>
            <Link to="/portal/kb" className="rounded px-2 py-1 hover:bg-surface-2">
              Knowledge base
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2 text-[13px] sm:gap-3">
            <span className="hidden text-muted sm:inline">
              {me.contact?.firstName} {me.contact?.lastName} · {me.contact?.companyName}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await papi('POST', '/logout');
                qc.removeQueries({ queryKey: ['portal-me'] });
                navigate('/portal/login');
              }}
            >
              <LogOut /> <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4">{children}</main>
    </div>
  );
}

function Login() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const login = useMutation({
    mutationFn: () => papi<{ csrfToken: string }>('POST', '/login', { email, password }),
    onSuccess: async (r) => {
      portalCsrf = r.csrfToken;
      await qc.invalidateQueries({ queryKey: ['portal-me'] });
      navigate('/portal');
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-base font-semibold">Customer support portal</h1>
        <p className="mt-1 text-[13px] text-muted">Sign in to follow your tickets and request help.</p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            login.mutate();
          }}
        >
          <div>
            <Label htmlFor="pemail">E-mail</Label>
            <Input id="pemail" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="ppass">Password</Label>
            <Input id="ppass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <p className="rounded bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" size="lg" loading={login.isPending}>
            Sign in
          </Button>
          <button
            type="button"
            className="w-full cursor-pointer text-center text-xs text-muted hover:text-foreground"
            onClick={async () => {
              if (!email) return setError('Enter your e-mail address first');
              await papi('POST', '/forgot-password', { email });
              toast.success('If an account exists, a reset link has been sent to your e-mail.');
            }}
          >
            Forgot your password?
          </button>
        </form>
      </Card>
    </div>
  );
}

interface PTicket {
  id: number;
  ticketNumber: string;
  title: string;
  statusName: string;
  statusColor: string;
  statusCategory: string;
  priorityName: string;
  contactName: string | null;
  createdAt: string;
  lastActivityAt: string;
}

function TicketList({ me }: { me: Me }) {
  const [state, setState] = useState('open');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['portal-tickets', state], queryFn: () => papi<{ data: PTicket[] }>('GET', `/tickets?state=${state}`) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{me.contact?.seesCompanyTickets ? `${me.contact.companyName} tickets` : 'My tickets'}</h1>
        <div className="ml-auto flex gap-1">
          {['open', 'closed', 'all'].map((s) => (
            <Button key={s} size="sm" variant={state === s ? 'subtle' : 'ghost'} onClick={() => setState(s)}>
              {s === 'open' ? 'Open' : s === 'closed' ? 'Resolved' : 'All'}
            </Button>
          ))}
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> New request
          </Button>
        </div>
      </div>
      {creating && <NewTicket onDone={() => setCreating(false)} />}
      <Card>
        {q.isLoading ? (
          <PageLoader />
        ) : !q.data?.data.length ? (
          <EmptyState icon={<Ticket />} title="No tickets" description="Use “New request” to ask for help." />
        ) : (
          <ul className="divide-y divide-border">
            {q.data.data.map((t) => (
              <li key={t.id}>
                <Link to={`/portal/tickets/${t.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2 sm:flex-nowrap">
                  <span className="font-mono text-xs text-muted">{t.ticketNumber}</span>
                  <span className="order-first min-w-0 basis-full text-[14px] font-medium sm:order-none sm:flex-1 sm:basis-0 sm:truncate sm:text-[13px]">{t.title}</span>
                  {me.contact?.seesCompanyTickets && <span className="text-xs text-muted">{t.contactName}</span>}
                  <StatusBadge name={t.statusName} color={t.statusColor} />
                  <span className="ml-auto text-right text-xs text-muted sm:ml-0 sm:w-28">{fmtRelative(t.lastActivityAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function NewTicket({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => papi<{ id: number; ticketNumber: string }>('POST', '/tickets', { title, description }),
    onSuccess: (t) => {
      toast.success(`Request ${t.ticketNumber} created`);
      qc.invalidateQueries({ queryKey: ['portal-tickets'] });
      onDone();
      navigate(`/portal/tickets/${t.id}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card>
      <CardHeader title="New request" />
      <CardBody className="space-y-3">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary, e.g. “Outlook does not open”" />
        <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happens, since when, error messages, how urgent…" />
        <div className="flex gap-2">
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="primary" disabled={title.trim().length < 3} loading={create.isPending} onClick={() => create.mutate()}>
            Submit request
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function TicketView() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const [reply, setReply] = useState('');
  const q = useQuery({
    queryKey: ['portal-ticket', id],
    queryFn: () =>
      papi<PTicket & { description: string | null; resolution: string | null; notes: { id: number; body: string; author: string | null; fromCustomer: boolean; createdAt: string }[] }>('GET', `/tickets/${id}`),
  });
  const send = useMutation({
    mutationFn: () => papi('POST', `/tickets/${id}/replies`, { body: reply }),
    onSuccess: () => {
      setReply('');
      qc.invalidateQueries({ queryKey: ['portal-ticket', id] });
      toast.success('Reply sent');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <EmptyState title="Ticket not found" />;
  const t = q.data;
  return (
    <div className="space-y-4">
      <Link to="/portal" className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <ArrowLeft className="size-3" /> Back to tickets
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t.title}</h1>
        <StatusBadge name={t.statusName} color={t.statusColor} />
        <span className="font-mono text-xs text-muted">{t.ticketNumber}</span>
      </div>
      {t.description && (
        <Card>
          <CardBody>
            <p className="prose-note text-[13px]">{t.description}</p>
          </CardBody>
        </Card>
      )}
      {t.resolution && (
        <Card className="border-success/40">
          <CardHeader title="Resolution" />
          <CardBody>
            <p className="prose-note text-[13px]">{t.resolution}</p>
          </CardBody>
        </Card>
      )}
      <div className="space-y-2">
        {t.notes.map((n) => (
          <div key={n.id} className={n.fromCustomer ? 'ml-12 rounded-md border border-border bg-surface-2 p-3' : 'mr-12 rounded-md border border-primary/30 bg-primary-soft/30 p-3'}>
            <div className="mb-1 text-[11px] text-muted">
              {n.fromCustomer ? 'You / your colleague' : (n.author ?? 'Support')} · {fmtDateTime(n.createdAt)}
            </div>
            <p className="prose-note text-[13px]">{n.body}</p>
          </div>
        ))}
      </div>
      <Card>
        <CardBody className="space-y-2">
          <Textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" />
          <Button variant="primary" disabled={!reply.trim()} loading={send.isPending} onClick={() => send.mutate()}>
            Send reply
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

function KnowledgeBase() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const list = useQuery({ queryKey: ['portal-kb', q], queryFn: () => papi<{ data: { id: number; title: string; excerpt: string }[] }>('GET', `/kb?q=${encodeURIComponent(q)}`) });
  const article = useQuery({ queryKey: ['portal-kb-article', open], queryFn: () => papi<{ title: string; body: string }>('GET', `/kb/${open}`), enabled: open !== null });
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Knowledge base</h1>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search articles…" />
      {open !== null && article.data ? (
        <Card>
          <CardHeader title={article.data.title} actions={<Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Back</Button>} />
          <CardBody>
            <Markdown source={article.data.body} />
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-2">
          {(list.data?.data ?? []).length === 0 && <EmptyState icon={<BookOpen />} title="No articles found" />}
          {list.data?.data.map((a) => (
            <Card key={a.id} className="cursor-pointer p-4 hover:border-border-strong" onClick={() => setOpen(a.id)}>
              <div className="text-[14px] font-medium">{a.title}</div>
              <p className="mt-1 line-clamp-2 text-xs text-muted">{a.excerpt}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const reset = useMutation({
    mutationFn: () => papi('POST', '/reset-password', { token: params.get('token') ?? '', password }),
    onSuccess: () => {
      toast.success('Password changed — you can sign in now');
      navigate('/portal/login');
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-base font-semibold">Choose a new password</h1>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            reset.mutate();
          }}
        >
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 10 characters" />
          {error && <p className="rounded bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" disabled={password.length < 10} loading={reset.isPending}>
            Save password
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** Customer portal, mounted at /portal/* outside the staff application. */
export default function PortalApp() {
  const me = usePortalMe();
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route path="reset" element={<ResetPassword />} />
      <Route
        path="*"
        element={
          me.isLoading ? (
            <PageLoader />
          ) : !me.data?.contact ? (
            <Navigate to="/portal/login" replace />
          ) : (
            <Shell me={me.data}>
              <Routes>
                <Route index element={<TicketList me={me.data} />} />
                <Route path="tickets/:id" element={<TicketView />} />
                <Route path="kb" element={<KnowledgeBase />} />
              </Routes>
            </Shell>
          )
        }
      />
    </Routes>
  );
}

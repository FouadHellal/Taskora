import { createContext, Fragment, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, BookOpen, Building2, Clock, FileText, HardDrive, Home, LogOut, Menu, Plus, Receipt, Ticket, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { isLang, loadLanguage, setLanguage, translate as t, type Lang } from '@/lib/i18n';
import { cn, setDateConfig } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { PageLoader } from '@/components/ui/misc';
import { logoUrl } from '@/components/logo';
import { companyLogoUrl, papi, setPortalCsrf, storedPortalLanguage, storePortalLanguage, usePortalMe, type Me } from './lib';

const PortalHome = lazy(() => import('./home'));
const PortalTickets = lazy(() => import('./tickets'));
const PortalWork = lazy(() => import('./work'));
const PortalDevices = lazy(() => import('./devices'));
const PortalDocs = lazy(() => import('./docs'));
const PortalProfile = lazy(() => import('./profile'));
const PortalReports = lazy(() => import('./reports'));
const PortalBilling = lazy(() => import('./billing'));

/* ------------------------------------------------------------------ language */

const LangContext = createContext<{ lang: Lang; change: (l: Lang | null) => void }>({ lang: 'en', change: () => {} });
export const usePortalLanguage = () => useContext(LangContext);

function browserLanguage(): Lang | null {
  for (const l of navigator.languages ?? [navigator.language]) {
    const code = l?.slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return null;
}

/** The portal has its own language choice: saved in this browser, else the browser language, else the organization default. */
function PortalI18n({ orgLanguage, children }: { orgLanguage?: string; children: ReactNode }) {
  const [choice, setChoice] = useState<string | null>(storedPortalLanguage());
  const wanted: Lang = isLang(choice) ? choice : (browserLanguage() ?? (isLang(orgLanguage) ? orgLanguage : 'en'));
  const [active, setActive] = useState<Lang | null>(wanted === 'en' ? 'en' : null);

  useEffect(() => {
    let cancelled = false;
    loadLanguage(wanted)
      .catch(() => ({}))
      .then((d) => {
        if (cancelled) return;
        setLanguage(wanted, d);
        setActive(wanted);
      });
    return () => {
      cancelled = true;
    };
  }, [wanted]);

  if (!active) return <PageLoader />;
  setLanguage(active);
  setDateConfig({ locale: active, dateFormat: 'auto' });
  return (
    <LangContext.Provider
      value={{
        lang: active,
        change: (l) => {
          storePortalLanguage(l);
          setChoice(l);
        },
      }}
    >
      <Fragment key={active}>{children}</Fragment>
    </LangContext.Provider>
  );
}

/* --------------------------------------------------------------------- shell */

function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  const f = me.features!;
  const c = me.contact!;
  useEffect(() => setMenu(false), [location.pathname]);

  const nav = [
    { to: '/portal', label: 'Home', icon: Home, end: true },
    { to: '/portal/tickets', label: c.isManager ? 'Tickets' : 'My tickets', icon: Ticket },
    f.time && { to: '/portal/work', label: 'Work & hours', icon: Clock },
    f.reports && { to: '/portal/reports', label: 'Monthly reports', icon: BarChart3 },
    f.billing && { to: '/portal/billing', label: 'Contract & billing', icon: Receipt },
    f.devices && { to: '/portal/devices', label: c.isManager ? 'Devices' : 'My devices', icon: HardDrive },
    f.docs && { to: '/portal/docs', label: 'Documentation', icon: FileText },
    { to: '/portal/kb', label: 'Help articles', icon: BookOpen },
    { to: '/portal/profile', label: 'My account', icon: UserRound },
  ].filter(Boolean) as { to: string; label: string; icon: typeof Home; end?: boolean }[];

  const signOut = async () => {
    await papi('POST', '/logout').catch(() => null);
    setPortalCsrf(null);
    qc.removeQueries({ queryKey: ['portal-me'] });
    navigate('/portal/login');
  };

  const logo = logoUrl('organization', 0, me.logoUpdatedAt);
  const companyLogo = companyLogoUrl(c.companyLogoUpdatedAt);
  const sidebar = (
    <div className="flex h-full flex-col">
      {/* The client's own company comes first: logo and name. */}
      <Link to="/portal" className="mx-3 mb-3 mt-4 block overflow-hidden rounded-xl border border-border bg-surface-2">
        <div className="flex h-20 items-center justify-center bg-surface px-4">
          {companyLogo ? (
            <img src={companyLogo} alt={c.companyName} className="max-h-14 max-w-full object-contain" />
          ) : (
            <span className="flex size-12 items-center justify-center rounded-full bg-primary text-lg font-semibold text-white">
              {c.companyName
                .split(/\s+/)
                .slice(0, 2)
                .map((w) => w[0])
                .join('')
                .toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Building2 className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold">{c.companyName}</div>
            <div className="text-[11px] text-muted">{c.isManager ? t('Company manager') : t('User')}</div>
          </div>
        </div>
      </Link>
      <div className="px-3 pb-2">
        <Button variant="primary" className="w-full" onClick={() => navigate('/portal/tickets/new')}>
          <Plus /> New request
        </Button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground', isActive && 'bg-primary-soft font-medium text-primary hover:bg-primary-soft hover:text-primary')
            }
          >
            <n.icon className="size-4" /> {t(n.label)}
          </NavLink>
        ))}
      </nav>
      <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
        <img src={logo ?? '/favicon.svg'} alt="" className={logo ? 'h-5 max-w-20 object-contain' : 'size-5'} />
        <div className="min-w-0 text-[11px] leading-tight text-muted">
          {t('Supported by')} <span className="font-medium text-foreground">{me.organizationName}</span>
        </div>
      </div>
      <div className="border-t border-border p-3">
        <div className="mb-2 truncate text-[12px]">
          <div className="truncate font-medium">
            {c.firstName} {c.lastName}
          </div>
          <div className="truncate text-[11px] text-muted">{c.email}</div>
        </div>
        <Button size="sm" variant="ghost" className="w-full justify-start" onClick={signOut}>
          <LogOut /> Sign out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-border bg-surface md:block print:hidden">{sidebar}</aside>
      {/* Phone: top bar + slide-in menu */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface px-3 md:hidden print:hidden">
        <Button variant="ghost" size="sm" aria-label={t('Menu')} onClick={() => setMenu(true)}>
          <Menu />
        </Button>
        <Link to="/portal" className="flex min-w-0 flex-1 items-center gap-2 truncate text-[14px] font-semibold">
          {companyLogo && <img src={companyLogo} alt="" className="h-7 max-w-24 object-contain" />}
          <span className="truncate">{c.companyName}</span>
        </Link>
        <Button size="sm" variant="primary" onClick={() => navigate('/portal/tickets/new')} aria-label={t('New request')}>
          <Plus />
        </Button>
      </header>
      {menu && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenu(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface shadow-xl">
            <button className="absolute right-2 top-3 cursor-pointer rounded p-1 text-muted hover:text-foreground" aria-label={t('Close')} onClick={() => setMenu(false)}>
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <main className="md:pl-60 print:pl-0">
        <div className="mx-auto max-w-5xl p-4 sm:p-6">
          <Suspense fallback={<PageLoader />}>{children}</Suspense>
        </div>
      </main>
    </div>
  );
}

/* ----------------------------------------------------------- sign-in pages */

function PortalAuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const info = useQuery({ queryKey: ['portal-info'], queryFn: () => papi<{ organizationName: string; logoUpdatedAt: string | null; enabled: boolean }>('GET', '/info') });
  const logo = logoUrl('organization', 0, info.data?.logoUpdatedAt);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src={logo ?? '/favicon.svg'} alt="" className={logo ? 'h-12 max-w-48 object-contain' : 'size-9'} />
          <div>
            <div className="text-lg font-semibold tracking-tight">{info.data?.organizationName ?? 'Taskora'}</div>
            <div className="text-[12px] text-muted">{t('Client portal')}</div>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="text-base font-semibold">{t(title)}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{t(subtitle)}</p>}
          {info.data && !info.data.enabled ? (
            <p className="mt-4 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">{t('The client portal is currently turned off. Please contact your IT team.')}</p>
          ) : (
            <div className="mt-5">{children}</div>
          )}
        </div>
        <p className="mt-4 text-center text-[12px] text-muted">
          {t('IT team?')}{' '}
          <Link to="/login" className="text-primary hover:underline">
            {t('Staff sign-in')}
          </Link>
        </p>
      </div>
    </div>
  );
}

function Login() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [forgot, setForgot] = useState(false);
  const login = useMutation({
    mutationFn: () => papi<{ csrfToken: string }>('POST', '/login', { email, password }),
    onSuccess: async (r) => {
      setPortalCsrf(r.csrfToken);
      await qc.invalidateQueries({ queryKey: ['portal-me'] });
      navigate('/portal');
    },
    onError: (e) => setError((e as Error).message),
  });
  const reset = useMutation({
    mutationFn: () => papi('POST', '/forgot-password', { email }),
    onSuccess: () => {
      toast.success(t('If an account exists for this address, we sent you a link to choose a new password.'));
      setForgot(false);
    },
    onError: (e) => setError((e as Error).message),
  });

  if (forgot)
    return (
      <PortalAuthCard title="Forgot your password?" subtitle="Enter your e-mail address and we will send you a link to choose a new one.">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            reset.mutate();
          }}
        >
          <div>
            <Label htmlFor="femail">E-mail</Label>
            <Input id="femail" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          {error && <p className="rounded bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" size="lg" loading={reset.isPending}>
            Send the link
          </Button>
          <button type="button" className="w-full cursor-pointer text-center text-xs text-muted hover:text-foreground" onClick={() => setForgot(false)}>
            {t('Back to sign-in')}
          </button>
        </form>
      </PortalAuthCard>
    );

  return (
    <PortalAuthCard title="Sign in as a client" subtitle="Open requests, follow your tickets, see the work done and keep your documentation.">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          login.mutate();
        }}
      >
        <div>
          <Label htmlFor="pemail">E-mail</Label>
          <Input id="pemail" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </div>
        <div>
          <Label htmlFor="ppass">Password</Label>
          <Input id="ppass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="rounded bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" size="lg" loading={login.isPending}>
          Sign in
        </Button>
        <button type="button" className="w-full cursor-pointer text-center text-xs text-muted hover:text-foreground" onClick={() => setForgot(true)}>
          {t('Forgot your password?')}
        </button>
      </form>
    </PortalAuthCard>
  );
}

function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const invite = params.get('invite') === '1';
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const reset = useMutation({
    mutationFn: () => papi('POST', '/reset-password', { token: params.get('token') ?? '', password }),
    onSuccess: () => {
      toast.success(t('Password saved — you can sign in now'));
      navigate('/portal/login');
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <PortalAuthCard title={invite ? 'Welcome! Choose your password' : 'Choose a new password'} subtitle={invite ? 'You will use it with your e-mail address to sign in to the client portal.' : undefined}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          reset.mutate();
        }}
      >
        <div>
          <Label htmlFor="np1">New password</Label>
          <Input id="np1" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('At least 10 characters')} autoFocus />
        </div>
        <div>
          <Label htmlFor="np2">Repeat the password</Label>
          <Input id="np2" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
          {password2 && password !== password2 && <p className="mt-1 text-xs text-danger">{t('The passwords do not match')}</p>}
        </div>
        {error && <p className="rounded bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
        <Button type="submit" variant="primary" className="w-full" size="lg" disabled={password.length < 10 || password !== password2} loading={reset.isPending}>
          Save password
        </Button>
      </form>
    </PortalAuthCard>
  );
}

/* -------------------------------------------------------------------- app */

function Authenticated() {
  const me = usePortalMe();
  if (me.isLoading) return <PageLoader />;
  if (!me.data?.contact) return <Navigate to="/portal/login" replace />;
  return (
    <Shell me={me.data}>
      <Routes>
        <Route index element={<PortalHome me={me.data} />} />
        <Route path="tickets/*" element={<PortalTickets me={me.data} />} />
        {me.data.features?.time && <Route path="work" element={<PortalWork me={me.data} />} />}
        {me.data.features?.devices && <Route path="devices" element={<PortalDevices me={me.data} />} />}
        <Route path="docs/*" element={<PortalDocs me={me.data} kind="docs" />} />
        <Route path="kb/*" element={<PortalDocs me={me.data} kind="kb" />} />
        <Route path="profile" element={<PortalProfile me={me.data} />} />
        {me.data.features?.reports && <Route path="reports/*" element={<PortalReports me={me.data} />} />}
        {me.data.features?.billing && <Route path="billing" element={<PortalBilling me={me.data} />} />}
        <Route path="*" element={<Navigate to="/portal" replace />} />
      </Routes>
    </Shell>
  );
}

/** Client portal, mounted at /portal/* outside the staff application. */
export default function PortalApp() {
  const me = usePortalMe();
  if (me.isLoading) return <PageLoader />;
  return (
    <PortalI18n orgLanguage={me.data?.language}>
      <Routes>
        <Route path="login" element={me.data?.contact ? <Navigate to="/portal" replace /> : <Login />} />
        <Route path="reset" element={<ResetPassword />} />
        <Route path="*" element={<Authenticated />} />
      </Routes>
    </PortalI18n>
  );
}


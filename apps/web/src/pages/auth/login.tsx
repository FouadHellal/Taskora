import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { logoUrl } from '@/components/logo';
import { translate as t } from '@/lib/i18n';

export function AuthCard({ title, subtitle, logo, children }: { title: string; subtitle?: string; logo?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src={logo ?? '/favicon.svg'} alt="" className={logo ? 'h-10 max-w-40 object-contain' : 'size-8'} />
          {!logo && <span className="text-xl font-semibold tracking-tight">Taskora</span>}
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-card">
          <h1 className="text-base font-semibold">{t(title)}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{t(subtitle)}</p>}
          <div className="mt-5">{children}</div>
        </div>
        <p className="mt-4 text-center text-[11px] text-subtle">{t('Self-hosted professional services automation')}</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean; organizationName: string; logoUpdatedAt?: string | null }>('/setup/status') });

  if (me) return <Navigate to={(location.state as { from?: string })?.from ?? '/'} replace />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post<{ csrfToken: string }>('/auth/login', { email, password });
      setCsrfToken(res.csrfToken);
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate((location.state as { from?: string })?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? t(err.message) : t('Unable to sign in'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title={t('Sign in to {name}', { name: setup.data?.organizationName ?? 'Taskora' })} logo={logoUrl('organization', 0, setup.data?.logoUpdatedAt)}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor="email">E-mail</Label>
          <Input id="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

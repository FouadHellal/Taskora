import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Languages, Monitor, Moon, Sun, Users } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES, translate as t, type Lang } from '@/lib/i18n';
import { cn, fmtRelative } from '@/lib/utils';
import { useTheme } from '@/hooks/use-theme';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { Card, CardBody, CardHeader, PageLoader } from '@/components/ui/misc';
import { papi, storedPortalLanguage, type Me } from './lib';
import { usePortalLanguage } from './index';

interface Profile {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  lastLoginAt: string | null;
  isManager: boolean;
  colleagues: { id: number; name: string; email: string | null; portalEnabled: boolean }[];
}

export default function PortalProfile({ me }: { me: Me }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['portal-profile'], queryFn: () => papi<Profile>('GET', '/profile') });
  const { lang, change } = usePortalLanguage();
  const { theme, setTheme } = useTheme();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const pw = useMutation({
    mutationFn: () => papi('POST', '/profile/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success(t('Password changed. Other sessions were signed out.'));
      setCurrent('');
      setNext('');
      setNext2('');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (q.isLoading) return <PageLoader />;
  const p = q.data;
  const c = me.contact!;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{t('My account')}</h1>
        <p className="text-[12px] text-muted">{t('Your details, password and display preferences.')}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="My details" />
          <CardBody className="space-y-2 text-[13px]">
            <Row label="Name">
              {p?.firstName} {p?.lastName}
            </Row>
            <Row label="E-mail">{p?.email}</Row>
            {p?.title && <Row label="Job title">{p.title}</Row>}
            {(p?.phone || p?.mobile) && <Row label="Phone">{[p?.phone, p?.mobile].filter(Boolean).join(' · ')}</Row>}
            <Row label="Company">{c.companyName}</Row>
            <Row label="Access">{c.isManager ? t('Company manager — sees every ticket, the work and the contracts of the company') : t('User — sees the requests they opened')}</Row>
            <Row label="Last sign-in">{fmtRelative(p?.lastLoginAt)}</Row>
            <p className="pt-2 text-[12px] text-muted">
              {t('Something wrong?')}{' '}
              <button className="cursor-pointer text-primary hover:underline" onClick={() => navigate('/portal/tickets/new')}>
                {t('Ask the IT team to update it.')}
              </button>
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-1.5"><KeyRound className="size-4 text-primary" /> {t('Change password')}</span>} />
          <CardBody>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                pw.mutate();
              }}
            >
              <input type="email" autoComplete="username" value={p?.email ?? ''} readOnly hidden />
              <div>
                <Label htmlFor="cur">Current password</Label>
                <Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="new1">New password</Label>
                <Input id="new1" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder={t('At least 10 characters')} />
              </div>
              <div>
                <Label htmlFor="new2">Repeat the password</Label>
                <Input id="new2" type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} />
                {next2 && next !== next2 && <p className="mt-1 text-xs text-danger">{t('The passwords do not match')}</p>}
              </div>
              <Button type="submit" variant="primary" disabled={!current || next.length < 10 || next !== next2} loading={pw.isPending}>
                Change password
              </Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-1.5"><Languages className="size-4 text-primary" /> {t('Display')}</span>} />
          <CardBody className="space-y-4 text-[13px]">
            <div>
              <Label htmlFor="lang">Language</Label>
              <Select id="lang" value={storedPortalLanguage() ?? ''} onChange={(e) => change((e.target.value || null) as Lang | null)}>
                <option value="">{t('Automatic ({lang})', { lang: LANGUAGES.find((l) => l.code === lang)?.label ?? lang })}</option>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Theme</Label>
              <div className="flex gap-2">
                {(
                  [
                    ['light', 'Light', Sun],
                    ['dark', 'Dark', Moon],
                    ['system', 'Automatic', Monitor],
                  ] as const
                ).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    onClick={() => setTheme(key)}
                    className={cn('flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px]', theme === key ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:border-border-strong')}
                  >
                    <Icon className="size-3.5" /> {t(label)}
                  </button>
                ))}
              </div>
            </div>
          </CardBody>
        </Card>

        {p?.isManager && (
          <Card>
            <CardHeader title={<span className="inline-flex items-center gap-1.5"><Users className="size-4 text-primary" /> {t('Colleagues')}</span>} />
            <ul className="divide-y divide-border">
              {p.colleagues.map((col) => (
                <li key={col.id} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{col.name}</span>
                    <span className="block truncate text-[11px] text-muted">{col.email ?? '—'}</span>
                  </span>
                  {col.portalEnabled ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-success">
                      <CheckCircle2 className="size-3" /> {t('Portal access')}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted">{t('No portal access')}</span>
                  )}
                </li>
              ))}
            </ul>
            <CardBody className="border-t border-border text-[12px] text-muted">
              {t('To give a colleague access, or to add someone who joined,')}{' '}
              <button className="cursor-pointer text-primary hover:underline" onClick={() => navigate('/portal/tickets/new')}>
                {t('open a request')}
              </button>
              .
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-muted">{t(label)}</span>
      <span className="min-w-0 flex-1 break-words">{children || '—'}</span>
    </div>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, Languages, Mail, Monitor, Moon, Sun, Users } from 'lucide-react';
import { toast } from 'sonner';
import { LANGUAGES, translate as t, type Lang } from '@/lib/i18n';
import { cn, fmtRelative } from '@/lib/utils';
import { useTheme } from '@/hooks/use-theme';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { Card, CardBody, CardHeader, PageLoader } from '@/components/ui/misc';
import { Switch } from '@/components/admin/switch';
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

        <EmailPreferences />

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

type PrefKey = 'ticketCreated' | 'ticketReplies' | 'ticketResolved' | 'monthlyReport' | 'companyTickets';
interface Prefs {
  email: string | null;
  preferences: Record<PrefKey, boolean>;
  isManager: boolean;
  clientEmailsEnabled: boolean;
}

const PREF_ROWS: { key: PrefKey; label: string; hint: string; managers?: boolean }[] = [
  { key: 'ticketCreated', label: 'Confirmation of my new requests', hint: 'With the reference number of the request.' },
  { key: 'ticketReplies', label: 'Replies from the IT team', hint: 'When a technician answers one of my requests.' },
  { key: 'ticketResolved', label: 'Request resolved', hint: 'With the solution, so I can check it works.' },
  { key: 'monthlyReport', label: 'Monthly report available', hint: 'A short summary with a link to the report.', managers: true },
  { key: 'companyTickets', label: 'Every new request of my company', hint: 'A copy when a colleague opens a request.', managers: true },
];

/** Which e-mails the contact receives. */
function EmailPreferences() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['portal-email-prefs'], queryFn: () => papi<Prefs>('GET', '/profile/notifications') });
  const save = useMutation({
    mutationFn: (patch: Partial<Record<PrefKey, boolean>>) => papi<{ preferences: Prefs['preferences'] }>('PUT', '/profile/notifications', patch),
    onSuccess: (r) => {
      qc.setQueryData<Prefs>(['portal-email-prefs'], (old) => (old ? { ...old, preferences: r.preferences } : old));
      toast.success(t('Saved'));
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const p = q.data;
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Mail className="size-4 text-primary" /> {t('E-mails I receive')}
          </span>
        }
        description={p?.email ? t('Sent to {email}', { email: p.email }) : t('Your contact has no e-mail address: ask your IT team to add one.')}
      />
      <CardBody className="space-y-3 text-[13px]">
        {!p ? (
          <PageLoader />
        ) : (
          <>
            {!p.clientEmailsEnabled && <p className="rounded bg-warning-soft px-3 py-2 text-[12px] text-warning">{t('E-mails to clients are currently turned off by your IT team.')}</p>}
            {PREF_ROWS.filter((r) => !r.managers || p.isManager).map((r) => (
              <div key={r.key} className="flex items-start gap-3">
                <Switch checked={p.preferences[r.key]} disabled={save.isPending || !p.email} onChange={(v) => save.mutate({ [r.key]: v })} label={undefined} />
                <div className="leading-tight">
                  <div className="font-medium">{t(r.label)}</div>
                  <div className="text-[11px] text-muted">{t(r.hint)}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </CardBody>
    </Card>
  );
}

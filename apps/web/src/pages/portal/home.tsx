import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  HardDrive,
  Hourglass,
  Inbox,
  MessageSquarePlus,
  Plus,
  Receipt,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { getLanguage, translate as t } from '@/lib/i18n';
import { fmtDate, fmtRelative } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageLoader } from '@/components/ui/misc';
import { ColumnChart, Progress } from '@/components/charts';
import { StatusBadge } from '@/components/badges';
import { Markdown } from '@/components/kb/markdown';
import { companyLogoUrl, fmtMinutes, fmtMoney, HEALTH_COLOR, monthName, papi, STATE_LABEL, type Health, type Me, type PTicket } from './lib';
import { HealthGauge, HealthParts } from './widgets';

interface Dashboard {
  counts: { open: number; waiting: number; resolved30: number; total: number; minutesMonth: number; docs: number };
  recent: PTicket[];
}

interface Insights {
  trend?: { month: string; minutes: number }[];
  activity: { opened30: number; resolved30: number; avgResolutionHours: number | null; slaMetPct: number | null };
  health?: Health;
  security?: { endpoints: number; online: number; patchedPct: number | null; fullyPatchedPct: number | null; rebootRequired: number; withCriticalUpdates: number; lastSyncAt: string | null } | null;
  devices?: { name: string; count: number }[];
  latestReport?: { id: number; period: string; title: string; healthScore: number | null } | null;
  agreement?: { name: string; endDate: string | null; daysLeft: number | null; autoRenew: boolean; termProgress: number | null; monthly: number; nextInvoiceDate: string | null; billingPeriod: string; currency: string } | null;
}

function Tile({ icon, label, value, hint, to, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string; to?: string; tone?: 'warning' | 'success' }) {
  const body = (
    <Card className={to ? 'h-full p-4 transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-sm' : 'h-full p-4'}>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <span
          className={
            'flex size-7 items-center justify-center rounded-full ' +
            (tone === 'warning' ? 'bg-warning-soft text-warning' : tone === 'success' ? 'bg-success-soft text-success' : 'bg-primary-soft text-primary')
          }
        >
          {icon}
        </span>
        {t(label)}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{t(hint)}</div>}
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

const hoursText = (h: number | null | undefined) => (h == null ? '—' : h < 24 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} ${t('days')}`);

export default function PortalHome({ me }: { me: Me }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['portal-dashboard'], queryFn: () => papi<Dashboard>('GET', '/dashboard') });
  const ins = useQuery({ queryKey: ['portal-insights'], queryFn: () => papi<Insights>('GET', '/dashboard/insights') });
  const c = me.contact!;
  const f = me.features!;
  if (q.isLoading) return <PageLoader />;
  const d = q.data;
  const i = ins.data;
  const lang = getLanguage();
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const logo = companyLogoUrl(c.companyLogoUpdatedAt);
  const grade = i?.health?.grade;

  return (
    <div className="space-y-5">
      {/* Hero */}
      <Card className="relative overflow-hidden">
        <div className="relative grid gap-5 p-5 sm:p-6 md:grid-cols-[1fr_auto] md:items-center">
          <div className="flex min-w-0 items-center gap-4">
            {logo && (
              <div className="hidden size-16 shrink-0 items-center justify-center rounded-xl border border-border bg-surface p-2 sm:flex">
                <img src={logo} alt="" className="max-h-full max-w-full object-contain" />
              </div>
            )}
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                {t(hello)}, {c.firstName}
              </h1>
              <p className="mt-1 text-[13px] text-muted">
                {grade
                  ? t(
                      grade === 'excellent' || grade === 'good'
                        ? 'Your IT is in good shape. Here is what is going on at {company}.'
                        : 'A few things need attention at {company}. We are on it.',
                      { company: c.companyName },
                    )
                  : t('Welcome to the {company} client portal.', { company: c.companyName })}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="primary" size="lg" onClick={() => navigate('/portal/tickets/new')}>
                  <MessageSquarePlus /> Ask for help
                </Button>
                {f.reports && i?.latestReport && (
                  <Button size="lg" onClick={() => navigate(`/portal/reports/${i.latestReport!.id}`)}>
                    <BarChart3 /> {t('Report of {month}', { month: monthName(i.latestReport.period, lang) })}
                  </Button>
                )}
              </div>
            </div>
          </div>
          {c.isManager && i?.health && (
            <div className="flex flex-col items-center">
              <div className="mb-1 text-[12px] font-medium text-muted">{t('IT health score')}</div>
              <HealthGauge health={i.health} size={160} />
            </div>
          )}
        </div>
      </Card>

      {d && d.counts.waiting > 0 && (
        <Link to="/portal/tickets?state=waiting" className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-[13px] hover:border-warning">
          <Hourglass className="size-5 shrink-0 text-warning" />
          <span className="flex-1">
            <b>{t('{n} requests are waiting for your answer.', { n: d.counts.waiting })}</b> {t('Please reply so we can continue.')}
          </span>
          <ArrowRight className="size-4 text-warning" />
        </Link>
      )}

      {me.welcome?.trim() && (
        <Card className="border-primary/30 bg-primary-soft/30">
          <CardBody className="text-[13px]">
            <Markdown source={me.welcome} />
          </CardBody>
        </Card>
      )}

      {d && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile icon={<Inbox className="size-4" />} label="Open requests" value={d.counts.open} to="/portal/tickets" hint={c.isManager ? 'For the whole company' : 'Opened by you'} />
          <Tile icon={<CheckCircle2 className="size-4" />} label="Resolved (30 days)" value={d.counts.resolved30} to="/portal/tickets?state=closed" tone="success" />
          <Tile icon={<Timer className="size-4" />} label="Average resolution time" value={hoursText(i?.activity.avgResolutionHours)} hint="Last 90 days" />
          {f.time ? (
            <Tile icon={<Clock className="size-4" />} label="Work this month" value={fmtMinutes(d.counts.minutesMonth)} to="/portal/work" hint="Time spent on your tickets" />
          ) : (
            <Tile icon={<ShieldCheck className="size-4" />} label="Response times met" value={i?.activity.slaMetPct == null ? '—' : `${i.activity.slaMetPct}%`} hint="Last 90 days" />
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader
              title="Latest activity"
              actions={
                <Link to="/portal/tickets?state=all" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  {t('All tickets')} <ArrowRight className="size-3" />
                </Link>
              }
            />
            {!d?.recent.length ? (
              <EmptyState
                icon={<Inbox />}
                title="No requests yet"
                description="When something does not work or you need help, open a request: we will keep you informed here."
                action={
                  <Button variant="primary" onClick={() => navigate('/portal/tickets/new')}>
                    <Plus /> New request
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {d.recent.map((tk) => (
                  <li key={tk.id}>
                    <Link to={`/portal/tickets/${tk.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                      <StateDot category={tk.statusCategory} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{tk.title}</div>
                        <div className="text-[11px] text-muted">
                          <span className="font-mono">{tk.ticketNumber}</span> · {t('updated {when}', { when: fmtRelative(tk.lastActivityAt) })}
                          {c.isManager && tk.contactName ? ` · ${tk.contactName}` : ''}
                        </div>
                      </div>
                      <StatusBadge name={tk.statusName} color={tk.statusColor} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {f.time && i?.trend && (
            <Card>
              <CardHeader title="Work done for you" description={t('Hours per month, last six months')} actions={<Link to="/portal/work" className="text-xs text-primary hover:underline">{t('Details')}</Link>} />
              <CardBody>
                <ColumnChart
                  height={140}
                  data={i.trend.map((m) => ({ x: monthName(m.month, lang, true), values: { hours: Math.round((m.minutes / 60) * 10) / 10 } }))}
                  series={[{ key: 'hours', label: t('Hours'), color: '#6366f1' }]}
                />
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {c.isManager && i?.health?.parts.length ? (
            <Card>
              <CardHeader title="What the score is made of" />
              <CardBody>
                <HealthParts health={i.health} />
              </CardBody>
            </Card>
          ) : null}

          {i?.security && (
            <Card>
              <CardHeader title="Device protection" actions={f.devices ? <Link to="/portal/devices" className="text-xs text-primary hover:underline">{t('Devices')}</Link> : null} />
              <CardBody className="space-y-3 text-[13px]">
                <div className="flex items-center gap-3">
                  {i.security.withCriticalUpdates ? <ShieldAlert className="size-8 text-warning" /> : <ShieldCheck className="size-8 text-success" />}
                  <div>
                    <div className="text-lg font-semibold">{i.security.patchedPct ?? 0}%</div>
                    <div className="text-[11px] text-muted">{t('of {n} devices have all critical updates', { n: i.security.endpoints })}</div>
                  </div>
                </div>
                <Progress value={i.security.patchedPct ?? 0} tone={(i.security.patchedPct ?? 0) >= 90 ? 'success' : 'warning'} />
                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <div className="rounded-md bg-surface-2 px-2.5 py-1.5">
                    <div className="text-muted">{t('Online now')}</div>
                    <div className="font-semibold">
                      {i.security.online} / {i.security.endpoints}
                    </div>
                  </div>
                  <div className="rounded-md bg-surface-2 px-2.5 py-1.5">
                    <div className="flex items-center gap-1 text-muted">
                      <RotateCcw className="size-3" /> {t('Restart pending')}
                    </div>
                    <div className="font-semibold">{i.security.rebootRequired}</div>
                  </div>
                </div>
              </CardBody>
            </Card>
          )}

          {!i?.security && i?.devices && i.devices.length > 0 && (
            <Card>
              <CardHeader title="Your equipment" actions={<Link to="/portal/devices" className="text-xs text-primary hover:underline">{t('Devices')}</Link>} />
              <CardBody className="space-y-1.5 text-[13px]">
                {i.devices.map((x) => (
                  <div key={x.name} className="flex items-center gap-2">
                    <HardDrive className="size-3.5 text-primary" />
                    <span className="flex-1">{t(x.name)}</span>
                    <span className="font-semibold tabular-nums">{x.count}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {i?.agreement && (
            <Link to="/portal/billing" className="block">
              <Card className="transition-colors hover:border-border-strong">
                <CardHeader title="Your agreement" actions={<Receipt className="size-4 text-primary" />} />
                <CardBody className="space-y-2 text-[13px]">
                  <div className="font-medium">{i.agreement.name}</div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {fmtMoney(i.agreement.monthly, i.agreement.currency, lang)}
                    <span className="ml-1 text-[12px] font-normal text-muted">{t('per month')}</span>
                  </div>
                  {i.agreement.termProgress != null && <Progress value={i.agreement.termProgress} />}
                  <div className="flex items-center gap-1.5 text-[11px] text-muted">
                    <CalendarClock className="size-3.5" />
                    {i.agreement.endDate
                      ? i.agreement.autoRenew
                        ? t('Renews automatically on {date}', { date: fmtDate(i.agreement.endDate) })
                        : t('Ends on {date}', { date: fmtDate(i.agreement.endDate) })
                      : t('No end date')}
                  </div>
                </CardBody>
              </Card>
            </Link>
          )}

          {f.reports && i?.latestReport && (
            <Link to={`/portal/reports/${i.latestReport.id}`} className="block">
              <Card className="transition-colors hover:border-border-strong">
                <CardBody className="flex items-center gap-3 text-[13px]">
                  <div
                    className="flex size-11 shrink-0 items-center justify-center rounded-full border-4 text-[12px] font-bold"
                    style={{
                      borderColor: i.latestReport.healthScore == null ? 'var(--border)' : HEALTH_COLOR[i.latestReport.healthScore >= 85 ? 'excellent' : i.latestReport.healthScore >= 70 ? 'good' : i.latestReport.healthScore >= 50 ? 'fair' : 'poor'],
                    }}
                  >
                    {i.latestReport.healthScore ?? '—'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-muted">{t('Latest monthly report')}</div>
                    <div className="truncate font-medium capitalize">{monthName(i.latestReport.period, lang)}</div>
                  </div>
                  <ArrowRight className="size-4 text-subtle" />
                </CardBody>
              </Card>
            </Link>
          )}

          <Card>
            <CardHeader title="Quick links" />
            <CardBody className="space-y-1.5 text-[13px]">
              <QuickLink to="/portal/tickets/new" icon={<Plus className="size-4" />} label="Open a new request" />
              <QuickLink to="/portal/tickets" icon={<Inbox className="size-4" />} label={c.isManager ? 'Company tickets' : 'My tickets'} />
              {f.docs && <QuickLink to="/portal/docs" icon={<FileText className="size-4" />} label="Our documentation" />}
              <QuickLink to="/portal/kb" icon={<BookOpen className="size-4" />} label="Help articles" />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function StateDot({ category }: { category: string }) {
  const color = category === 'waiting' ? 'var(--warning)' : category === 'resolved' || category === 'closed' ? 'var(--success)' : 'var(--primary)';
  return <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} title={t(STATE_LABEL[category] ?? category)} />;
}

function QuickLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link to={to} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2 hover:border-border-strong hover:bg-surface-2">
      <span className="text-primary">{icon}</span>
      <span className="flex-1">{t(label)}</span>
      <ArrowRight className="size-3.5 text-subtle" />
    </Link>
  );
}

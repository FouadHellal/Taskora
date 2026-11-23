import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Clock, FileText, Hourglass, Inbox, MessageSquarePlus, Plus } from 'lucide-react';
import { translate as t } from '@/lib/i18n';
import { fmtRelative } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageLoader } from '@/components/ui/misc';
import { StatusBadge } from '@/components/badges';
import { Markdown } from '@/components/kb/markdown';
import { fmtMinutes, papi, type Me, type PTicket } from './lib';

interface Dashboard {
  counts: { open: number; waiting: number; resolved30: number; total: number; minutesMonth: number; docs: number };
  recent: PTicket[];
}

function Tile({ icon, label, value, hint, to, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string; to?: string; tone?: 'warning' | 'success' }) {
  const body = (
    <Card className={to ? 'h-full p-4 transition-colors hover:border-border-strong' : 'h-full p-4'}>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <span className={tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-primary'}>{icon}</span> {t(label)}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{t(hint)}</div>}
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export default function PortalHome({ me }: { me: Me }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['portal-dashboard'], queryFn: () => papi<Dashboard>('GET', '/dashboard') });
  const c = me.contact!;
  const f = me.features!;
  if (q.isLoading) return <PageLoader />;
  const d = q.data;
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">
            {t(hello)}, {c.firstName}
          </h1>
          <p className="mt-0.5 text-[13px] text-muted">{t('Welcome to the {company} client portal.', { company: c.companyName })}</p>
        </div>
        <Button variant="primary" size="lg" onClick={() => navigate('/portal/tickets/new')}>
          <MessageSquarePlus /> Ask for help
        </Button>
      </div>

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
          <Tile icon={<Hourglass className="size-4" />} label="Waiting for you" value={d.counts.waiting} to="/portal/tickets?state=waiting" tone={d.counts.waiting ? 'warning' : undefined} hint={d.counts.waiting ? 'Please reply so we can continue' : 'Nothing to do'} />
          <Tile icon={<CheckCircle2 className="size-4" />} label="Resolved (30 days)" value={d.counts.resolved30} to="/portal/tickets?state=closed" tone="success" />
          {f.time ? (
            <Tile icon={<Clock className="size-4" />} label="Work this month" value={fmtMinutes(d.counts.minutesMonth)} to="/portal/work" hint="Time spent on your tickets" />
          ) : f.docs ? (
            <Tile icon={<FileText className="size-4" />} label="Documentation pages" value={d.counts.docs} to="/portal/docs" />
          ) : (
            <Tile icon={<Inbox className="size-4" />} label="All requests" value={d.counts.total} to="/portal/tickets?state=all" />
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
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
        <Card>
          <CardHeader title="Quick links" />
          <CardBody className="space-y-1.5 text-[13px]">
            <QuickLink to="/portal/tickets/new" icon={<Plus className="size-4" />} label="Open a new request" />
            <QuickLink to="/portal/tickets" icon={<Inbox className="size-4" />} label={c.isManager ? 'Company tickets' : 'My tickets'} />
            {f.time && <QuickLink to="/portal/work" icon={<Clock className="size-4" />} label="Work & hours" />}
            {f.docs && <QuickLink to="/portal/docs" icon={<FileText className="size-4" />} label="Our documentation" />}
            <QuickLink to="/portal/kb" icon={<CheckCircle2 className="size-4" />} label="Help articles" />
          </CardBody>
        </Card>
      </div>
    </div>
  );
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

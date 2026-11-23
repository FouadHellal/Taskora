import { Link, Route, Routes, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, ChevronRight, Printer } from 'lucide-react';
import { getLanguage, translate as t } from '@/lib/i18n';
import { fmtDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, PageLoader } from '@/components/ui/misc';
import { fmtMinutes, HEALTH_COLOR, monthName, papi, type Me } from './lib';
import { ReportView, type ReportData } from './widgets';

interface ReportRow {
  id: number;
  period: string;
  title: string;
  publishedAt: string;
  healthScore: number | null;
  opened: number | null;
  resolved: number | null;
  minutes: number | null;
}

const scoreColor = (s: number | null) => (s == null ? 'var(--subtle)' : HEALTH_COLOR[s >= 85 ? 'excellent' : s >= 70 ? 'good' : s >= 50 ? 'fair' : 'poor']);

function ReportList({ me }: { me: Me }) {
  const q = useQuery({ queryKey: ['portal-reports'], queryFn: () => papi<ReportRow[]>('GET', '/reports') });
  if (q.isLoading) return <PageLoader />;
  const rows = q.data ?? [];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('Monthly reports')}</h1>
        <p className="mt-0.5 text-[13px] text-muted">{t('Every month your IT team sums up what was done for {company}: requests, time, devices and security.', { company: me.contact!.companyName })}</p>
      </div>
      {!rows.length ? (
        <Card>
          <EmptyState icon={<BarChart3 />} title="No report yet" description="Your first monthly report will appear here as soon as your IT team publishes it." />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <Link key={r.id} to={`/portal/reports/${r.id}`} className="group">
              <Card className="h-full p-4 transition-colors group-hover:border-border-strong">
                <div className="flex items-start gap-3">
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-full border-4 text-[13px] font-bold" style={{ borderColor: scoreColor(r.healthScore), color: scoreColor(r.healthScore) }}>
                    {r.healthScore ?? '—'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-semibold capitalize">{monthName(r.period, getLanguage())}</div>
                    <div className="text-[11px] text-muted">{t('Published {date}', { date: fmtDate(r.publishedAt) })}</div>
                  </div>
                  <ChevronRight className="size-4 text-subtle group-hover:text-foreground" />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px] text-muted">
                  <div>
                    <div className="text-[15px] font-semibold text-foreground">{r.opened ?? 0}</div>
                    {t('opened')}
                  </div>
                  <div>
                    <div className="text-[15px] font-semibold text-foreground">{r.resolved ?? 0}</div>
                    {t('resolved')}
                  </div>
                  {me.features?.time && (
                    <div>
                      <div className="text-[15px] font-semibold text-foreground">{fmtMinutes(r.minutes)}</div>
                      {t('of work')}
                    </div>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportPage({ me }: { me: Me }) {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ['portal-report', id],
    queryFn: () => papi<{ id: number; period: string; title: string; summary: string; data: ReportData; publishedAt: string }>('GET', `/reports/${id}`),
  });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <EmptyState icon={<BarChart3 />} title="Report not found" />;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link to="/portal/reports" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> {t('All reports')}
        </Link>
        <Button size="sm" onClick={() => window.print()}>
          <Printer /> Print or save as PDF
        </Button>
      </div>
      <ReportView title={q.data.title} period={q.data.period} summary={q.data.summary} data={q.data.data} companyName={me.contact!.companyName} showTime={!!me.features?.time} />
    </div>
  );
}

export default function PortalReports({ me }: { me: Me }) {
  return (
    <Routes>
      <Route index element={<ReportList me={me} />} />
      <Route path=":id" element={<ReportPage me={me} />} />
    </Routes>
  );
}

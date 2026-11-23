import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileBarChart, Layers, Plus, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getLanguage, translate as t } from '@/lib/i18n';
import { fmtDate } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Badge, Card, EmptyState, PageLoader } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/overlays';
import { EntityPicker } from '@/components/entity-picker';
import { FormField, handleFormError } from '@/components/form';
import { fmtMinutes, monthName } from '@/pages/portal/lib';

export interface ClientReportRow {
  id: number;
  companyId: number;
  companyName: string;
  period: string;
  title: string;
  status: 'draft' | 'published';
  source: 'auto' | 'manual';
  publishedAt: string | null;
  emailedAt: string | null;
  updatedAt: string;
  healthScore: number | null;
  opened: number | null;
  minutes: number | null;
}

interface ListResponse {
  data: ClientReportRow[];
  automation: { mode: 'off' | 'draft' | 'publish'; day: number; lastRun: { lastPeriod?: string; ranAt?: string; created?: number } | null };
  suggestedPeriod: string;
  eligibleCompanies: number;
}

const AUTO_TEXT: Record<string, string> = {
  off: 'Automatic reports are off.',
  draft: 'On day {day} of each month, last month’s reports are prepared as drafts for you to review and publish.',
  publish: 'On day {day} of each month, last month’s reports are published and e-mailed to company managers automatically.',
};

/** Client reports for one company (company page tab) or all companies. */
export function ClientReportList({ companyId, compact }: { companyId?: number; compact?: boolean }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['client-reports', companyId ?? null, status],
    queryFn: () => api.get<ListResponse>(`/client-reports?${new URLSearchParams({ ...(companyId ? { companyId: String(companyId) } : {}), ...(status ? { status } : {}) })}`),
  });
  if (q.isLoading) return <PageLoader />;
  const r = q.data!;
  const lang = getLanguage();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!compact && (
          <p className="min-w-0 flex-1 text-[13px] text-muted">
            {t(AUTO_TEXT[r.automation.mode]!, { day: r.automation.day })}{' '}
            <Link to="/admin/portal" className="inline-flex items-center gap-0.5 text-primary hover:underline">
              <Settings2 className="size-3.5" /> {t('Change')}
            </Link>
          </p>
        )}
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">{t('All reports')}</option>
          <option value="draft">{t('Drafts')}</option>
          <option value="published">{t('Published')}</option>
        </Select>
        {compact && <div className="flex-1" />}
        {can('companies.write') && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus /> Prepare a report
          </Button>
        )}
      </div>
      {!r.data.length ? (
        <Card>
          <EmptyState icon={<FileBarChart />} title="No reports yet" description="Prepare a monthly report: Taskora gathers the tickets, time, devices and Action1 patch status of the month. You add a message and publish it to the client portal." />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="border-b border-border bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('Month')}</th>
                {!companyId && <th className="px-3 py-2 font-medium">{t('Company')}</th>}
                <th className="px-3 py-2 font-medium">{t('Status')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('Health')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('Requests')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('Time')}</th>
                <th className="px-3 py-2 font-medium">{t('Updated')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {r.data.map((x) => (
                <tr key={x.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/client-reports/${x.id}`)}>
                  <td className="px-3 py-2 font-medium capitalize">{monthName(x.period, lang)}</td>
                  {!companyId && <td className="px-3 py-2">{x.companyName}</td>}
                  <td className="px-3 py-2">
                    {x.status === 'published' ? <Badge tone="success">{t('Published')}</Badge> : <Badge tone="warning">{t('Draft')}</Badge>}
                    {x.source === 'auto' && <span className="ml-1.5 text-[11px] text-muted">{t('automatic')}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{x.healthScore ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{x.opened ?? 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMinutes(x.minutes)}</td>
                  <td className="px-3 py-2 text-muted">{fmtDate(x.publishedAt ?? x.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {creating && <PrepareDialog companyId={companyId} defaultPeriod={r.suggestedPeriod} eligible={r.eligibleCompanies} onClose={() => setCreating(false)} />}
    </div>
  );
}

function PrepareDialog({ companyId: fixedCompany, defaultPeriod, eligible, onClose }: { companyId?: number; defaultPeriod: string; eligible: number; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [companyId, setCompanyId] = useState<number | null>(fixedCompany ?? null);
  const [period, setPeriod] = useState(defaultPeriod);
  const one = useMutation({
    mutationFn: () => api.post<{ id: number }>('/client-reports', { companyId, period }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['client-reports'] });
      navigate(`/client-reports/${r.id}`);
    },
    onError: (e) => handleFormError(e),
  });
  const all = useMutation({
    mutationFn: () => api.post<{ created: number; refreshed: number }>('/client-reports/generate-all', { period }),
    onSuccess: (r) => {
      toast.success(t('{created} reports prepared, {refreshed} drafts refreshed', r));
      qc.invalidateQueries({ queryKey: ['client-reports'] });
      onClose();
    },
    onError: (e) => handleFormError(e),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Prepare a monthly report"
      description="The figures are taken now; you can refresh them until you publish."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {!fixedCompany && (
            <Button loading={all.isPending} onClick={() => all.mutate()} disabled={!/^\d{4}-\d{2}$/.test(period)}>
              <Layers /> {t('All client companies ({n})', { n: eligible })}
            </Button>
          )}
          <Button variant="primary" loading={one.isPending} disabled={!companyId || !/^\d{4}-\d{2}$/.test(period)} onClick={() => one.mutate()}>
            Prepare
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!fixedCompany && (
          <FormField label="Company">
            <EntityPicker kind="company" value={companyId} onChange={setCompanyId} />
          </FormField>
        )}
        <FormField label="Month">
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}

export default function ClientReportsPage() {
  return (
    <div>
      <PageHeader title="Client reports" icon={<FileBarChart />} subtitle="Monthly reports published to your clients in the client portal" />
      <div className="p-4 sm:p-5">
        <ClientReportList />
      </div>
    </div>
  );
}

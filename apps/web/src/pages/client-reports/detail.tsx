import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, EyeOff, FileBarChart, RefreshCw, Save, Send, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { translate as t } from '@/lib/i18n';
import { fmtDateTime } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, PageLoader } from '@/components/ui/misc';
import { ConfirmDialog } from '@/components/ui/overlays';
import { FormField, handleFormError } from '@/components/form';
import { ReportView, type ReportData } from '@/pages/portal/widgets';

interface Report {
  id: number;
  companyId: number;
  companyName: string;
  period: string;
  title: string;
  summary: string;
  data: ReportData;
  hiddenSections: string[];
  status: 'draft' | 'published';
  source: string;
  publishedAt: string | null;
  emailedAt: string | null;
  showTime: boolean;
}

const SECTIONS: { key: string; label: string }[] = [
  { key: 'tickets', label: 'Requests' },
  { key: 'work', label: 'Time spent' },
  { key: 'devices', label: 'Equipment' },
  { key: 'security', label: 'Security updates (Action1)' },
];

export default function ClientReportDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canWrite = can('companies.write');
  const q = useQuery({ queryKey: ['client-report', id], queryFn: () => api.get<Report>(`/client-reports/${id}`) });
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [hidden, setHidden] = useState<string[]>([]);
  const [notify, setNotify] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (q.data) {
      setTitle(q.data.title);
      setSummary(q.data.summary);
      setHidden(q.data.hiddenSections);
    }
  }, [q.data]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['client-report', id] });
    qc.invalidateQueries({ queryKey: ['client-reports'] });
  };
  const save = useMutation({
    mutationFn: () => api.patch(`/client-reports/${id}`, { title, summary, hiddenSections: hidden }),
    onSuccess: () => {
      toast.success(t('Saved'));
      refresh();
    },
    onError: (e) => handleFormError(e),
  });
  const action = useMutation({
    mutationFn: async (kind: 'refresh' | 'publish' | 'unpublish') => {
      if (kind === 'publish') await api.patch(`/client-reports/${id}`, { title, summary, hiddenSections: hidden });
      return api.post(`/client-reports/${id}/${kind}`, kind === 'publish' ? { notify } : {});
    },
    onSuccess: (_r, kind) => {
      toast.success(t(kind === 'refresh' ? 'Figures refreshed' : kind === 'publish' ? 'Report published' : 'Report moved back to drafts'));
      refresh();
    },
    onError: (e) => handleFormError(e),
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/client-reports/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-reports'] });
      navigate('/client-reports');
    },
    onError: (e) => handleFormError(e),
  });
  if (q.isLoading || !q.data) return <PageLoader />;
  const r = q.data;
  const previewData = Object.fromEntries(Object.entries(r.data).filter(([k]) => !hidden.includes(k))) as unknown as ReportData;

  return (
    <div>
      <PageHeader
        title={r.title}
        icon={<FileBarChart />}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link to={`/companies/${r.companyId}`} className="text-primary hover:underline">
              {r.companyName}
            </Link>
            {r.status === 'published' ? <Badge tone="success">{t('Published')}</Badge> : <Badge tone="warning">{t('Draft')}</Badge>}
            {r.publishedAt && <span className="text-[12px] text-muted">{t('Published {date}', { date: fmtDateTime(r.publishedAt) })}</span>}
            {r.emailedAt && <span className="text-[12px] text-muted">· {t('e-mailed {date}', { date: fmtDateTime(r.emailedAt) })}</span>}
          </span>
        }
        actions={
          <Link to="/client-reports">
            <Button>
              <ArrowLeft /> All reports
            </Button>
          </Link>
        }
      />
      <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Message to the client" />
            <CardBody className="space-y-3">
              <FormField label="Title">
                <Input value={title} disabled={!canWrite} onChange={(e) => setTitle(e.target.value)} />
              </FormField>
              <FormField label="Message from your IT team" hint="Markdown. What went well, what you did, what you recommend (e.g. replace two old laptops, plan an upgrade).">
                <Textarea rows={9} value={summary} disabled={!canWrite} onChange={(e) => setSummary(e.target.value)} />
              </FormField>
              <div>
                <div className="mb-1 flex items-center gap-1 text-[12px] font-medium">
                  <EyeOff className="size-3.5" /> {t('Hide sections')}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                {SECTIONS.map((s) => (
                  <Checkbox
                    key={s.key}
                    label={t(s.label)}
                    checked={hidden.includes(s.key)}
                    disabled={!canWrite}
                    onChange={(e) => setHidden(e.target.checked ? [...hidden, s.key] : hidden.filter((x) => x !== s.key))}
                  />
                ))}
                </div>
              </div>
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  <Button loading={save.isPending} onClick={() => save.mutate()}>
                    <Save /> Save
                  </Button>
                  <Button loading={action.isPending && action.variables === 'refresh'} onClick={() => action.mutate('refresh')}>
                    <RefreshCw /> Refresh figures
                  </Button>
                </div>
              )}
            </CardBody>
          </Card>
          {canWrite && (
            <Card>
              <CardHeader title={r.status === 'published' ? 'Published' : 'Publish'} />
              <CardBody className="space-y-3 text-[13px]">
                {r.status === 'draft' ? (
                  <>
                    <p className="text-muted">{t('Company managers will see the report in the client portal under Monthly reports.')}</p>
                    <Checkbox label={t('E-mail the company managers')} checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                    <Button variant="primary" className="w-full" loading={action.isPending && action.variables === 'publish'} onClick={() => action.mutate('publish')}>
                      <Send /> Publish to the client
                    </Button>
                  </>
                ) : (
                  <Button className="w-full" loading={action.isPending && action.variables === 'unpublish'} onClick={() => action.mutate('unpublish')}>
                    <Undo2 /> Unpublish
                  </Button>
                )}
                <Button variant="ghost" className="w-full text-danger" onClick={() => setConfirmDelete(true)}>
                  <Trash2 /> Delete report
                </Button>
              </CardBody>
            </Card>
          )}
        </div>
        <div>
          <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">{t('Preview — what the client sees')}</div>
          <ReportView title={title} period={r.period} summary={summary} data={previewData} companyName={r.companyName} showTime={r.showTime} />
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this report?"
        description="The client will no longer see it. You can prepare it again later."
        confirmLabel="Delete"
        danger
        loading={del.isPending}
        onConfirm={() => del.mutate()}
      />
    </div>
  );
}

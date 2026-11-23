import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { KB_STATUS } from '@taskora/shared';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Card, PageLoader } from '@/components/ui/misc';
import { FormField, handleFormError } from '@/components/form';
import { EntityPicker } from '@/components/entity-picker';
import { Markdown } from '@/components/kb/markdown';
import type { Article } from './article';

export default function ArticleEditorPage() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ['kb-categories'], queryFn: () => api.get<{ data: { id: number; name: string }[] }>('/kb/categories') });
  const existing = useQuery({ queryKey: ['kb-article', id, 'edit'], queryFn: () => api.get<Article>(`/kb/articles/${id}`), enabled: !!id });
  const [f, setF] = useState({
    title: '',
    body: '',
    categoryId: null as number | null,
    companyId: search.get('companyId') ? Number(search.get('companyId')) : (null as number | null),
    tags: '',
    visibility: 'internal',
    status: 'draft',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  useEffect(() => {
    const a = existing.data;
    if (a) {
      setF({ title: a.title, body: a.body, categoryId: a.categoryId, companyId: a.companyId, tags: a.tags.join(', '), visibility: a.visibility, status: a.status });
      setCompanyLabel(a.companyName);
    }
  }, [existing.data]);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) };
      return id ? api.patch<{ id: number }>(`/kb/articles/${id}`, body) : api.post<{ id: number }>('/kb/articles', body);
    },
    onSuccess: (a) => {
      toast.success('Article saved');
      qc.invalidateQueries({ queryKey: ['kb'] });
      qc.invalidateQueries({ queryKey: ['kb-article', a.id] });
      navigate(`/kb/${a.id}`);
    },
    onError: (e) => handleFormError(e, (name: string, err: { message: string }) => setErrors((x) => ({ ...x, [name]: err.message }))),
  });
  if (id && existing.isLoading) return <PageLoader />;
  const docs = !!f.companyId || search.get('docs') === '1';
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={id ? 'Edit article' : docs ? 'New document' : 'New article'}
        icon={<BookOpen />}
        breadcrumbs={[{ label: docs ? 'Documentation' : 'Knowledge Base', to: docs ? '/documentation' : '/kb' }, { label: id ? (existing.data?.articleNumber ?? '') : 'New' }]}
        actions={
          <>
            <Button onClick={() => navigate(-1)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} disabled={!f.title.trim()} onClick={() => save.mutate()}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-3 pb-3 md:grid-cols-6">
          <FormField label="Title" required error={errors.title} className="md:col-span-2">
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </FormField>
          <FormField label="Category">
            <Select value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: e.target.value ? Number(e.target.value) : null })} placeholder="—" options={(cats.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
          </FormField>
          <FormField label="Company (documentation)">
            <EntityPicker kind="company" value={f.companyId} label={companyLabel} onChange={(cid, o) => (setF({ ...f, companyId: cid }), setCompanyLabel(o?.label ?? null))} placeholder="General KB" />
          </FormField>
          <FormField label="Visibility" hint={f.visibility === 'public' ? (f.companyId ? 'Clients of this company read it in the client portal (Documentation) once published.' : 'All clients read it in the client portal (Help articles) once published.') : 'Only the IT team sees it.'}>
            <Select
              value={f.visibility}
              onChange={(e) => setF({ ...f, visibility: e.target.value })}
              options={[
                { value: 'internal', label: 'Internal (IT team only)' },
                { value: 'public', label: 'Public (client portal)' },
              ]}
            />
          </FormField>
          <FormField label="Status">
            <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={KB_STATUS.values.map((v) => ({ value: v, label: KB_STATUS.labels[v] }))} />
          </FormField>
          <FormField label="Tags (comma separated)" className="md:col-span-6">
            <Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="outlook, microsoft 365, profile" />
          </FormField>
        </div>
      </PageHeader>
      <div className="grid min-h-0 flex-1 gap-4 p-5 lg:grid-cols-2">
        <Card className="flex flex-col p-0">
          <div className="border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Markdown</div>
          <Textarea
            value={f.body}
            onChange={(e) => setF({ ...f, body: e.target.value })}
            className="min-h-[50vh] flex-1 rounded-none border-0 font-mono text-[12.5px] shadow-none focus:ring-0"
            placeholder={'# Symptoms\n\n# Cause\n\n# Resolution\n1. …'}
          />
        </Card>
        <Card className="overflow-auto p-0">
          <div className="border-b border-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Preview</div>
          <div className="px-6 py-4">{f.body ? <Markdown source={f.body} /> : <p className="text-xs text-muted">Nothing to preview yet.</p>}</div>
        </Card>
      </div>
    </div>
  );
}

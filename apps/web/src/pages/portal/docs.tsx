import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, Eye, FileText, Lock, Pencil, Plus, Save, Search, ShieldAlert, Trash2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { translate as t } from '@/lib/i18n';
import { cn, fmtDate, fmtRelative } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Badge, Card, CardBody, EmptyState, PageLoader } from '@/components/ui/misc';
import { ConfirmDialog } from '@/components/ui/overlays';
import { Markdown } from '@/components/kb/markdown';
import { papi, type Me } from './lib';

interface DocRow {
  id: number;
  title: string;
  excerpt: string;
  updatedAt: string;
  byClient?: boolean;
  authorName?: string | null;
}
interface Doc extends DocRow {
  body: string;
  canEdit?: boolean;
  updatedByName?: string | null;
}

/** Company documentation (kind "docs", clients can write) and the general help articles (kind "kb", read-only). */
export default function PortalDocs({ me, kind }: { me: Me; kind: 'docs' | 'kb' }) {
  if (kind === 'docs' && !me.features?.docs) return <Navigate to="/portal" replace />;
  return (
    <Routes>
      <Route index element={<DocList me={me} kind={kind} />} />
      {kind === 'docs' && <Route path="new" element={<DocEditor />} />}
      <Route path=":id" element={<DocView kind={kind} />} />
      {kind === 'docs' && <Route path=":id/edit" element={<DocEditor />} />}
    </Routes>
  );
}

function DocList({ me, kind }: { me: Me; kind: 'docs' | 'kb' }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['portal-docs', kind, search], queryFn: () => papi<{ data: DocRow[] }>('GET', `/${kind}?q=${encodeURIComponent(search)}`) });
  const docs = kind === 'docs';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{docs ? t('Documentation') : t('Help articles')}</h1>
          <p className="text-[12px] text-muted">
            {docs ? t('Shared notes about {company}: how things are set up, who to call, procedures… Your colleagues and the IT team can read them.', { company: me.contact!.companyName }) : t('Guides and answers from the IT team.')}
          </p>
        </div>
        {docs && (
          <Button variant="primary" onClick={() => navigate('/portal/docs/new')}>
            <Plus /> New page
          </Button>
        )}
      </div>
      <div className="relative sm:max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={docs ? 'Search the documentation…' : 'Search articles…'} className="pl-8" />
      </div>
      {q.isLoading ? (
        <PageLoader />
      ) : !q.data?.data.length ? (
        <Card>
          <EmptyState
            icon={docs ? <FileText /> : <BookOpen />}
            title={search ? 'Nothing matches your search' : docs ? 'No documentation yet' : 'No articles yet'}
            description={!search && docs ? 'Start with a page about your office: address, opening hours, important contacts, internet provider…' : undefined}
            action={
              !search && docs ? (
                <Button variant="primary" onClick={() => navigate('/portal/docs/new')}>
                  <Plus /> New page
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {q.data.data.map((d) => (
            <Link key={d.id} to={`/portal/${kind}/${d.id}`}>
              <Card className="h-full p-4 transition-colors hover:border-border-strong">
                <div className="flex items-start gap-2">
                  {docs ? <FileText className="mt-0.5 size-4 shrink-0 text-primary" /> : <BookOpen className="mt-0.5 size-4 shrink-0 text-primary" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{d.title}</div>
                    {d.excerpt && <p className="mt-1 line-clamp-2 text-[12px] text-muted">{d.excerpt}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                      {docs && (d.byClient ? <Badge tone="primary">{t('Written by your team')}</Badge> : <Badge tone="info">{t('From the IT team')}</Badge>)}
                      <span>{t('updated {when}', { when: fmtRelative(d.updatedAt) })}</span>
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function DocView({ kind }: { kind: 'docs' | 'kb' }) {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const q = useQuery({ queryKey: ['portal-doc', kind, id], queryFn: () => papi<Doc>('GET', `/${kind}/${id}`) });
  const remove = useMutation({
    mutationFn: () => papi('DELETE', `/docs/${id}`),
    onSuccess: () => {
      toast.success(t('Page deleted'));
      qc.invalidateQueries({ queryKey: ['portal-docs'] });
      navigate('/portal/docs');
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <EmptyState title="Page not found" />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <Link to={`/portal/${kind}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <ArrowLeft className="size-3" /> {kind === 'docs' ? t('Back to the documentation') : t('Back to the help articles')}
      </Link>
      <Card>
        <div className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight">{d.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
              {kind === 'docs' && (d.byClient ? <Badge tone="primary">{t('Written by your team')}</Badge> : <Badge tone="info">{t('From the IT team')}</Badge>)}
              {d.authorName && (
                <span className="inline-flex items-center gap-1">
                  <UserRound className="size-3" /> {d.authorName}
                </span>
              )}
              <span>
                {t('Updated {date}', { date: fmtDate(d.updatedAt) })}
                {d.updatedByName && d.updatedByName !== d.authorName ? ` · ${d.updatedByName}` : ''}
              </span>
            </div>
          </div>
          {kind === 'docs' &&
            (d.canEdit ? (
              <div className="flex gap-2">
                <Button onClick={() => navigate(`/portal/docs/${id}/edit`)}>
                  <Pencil /> Edit
                </Button>
                <Button variant="ghost" aria-label={t('Delete')} onClick={() => setDeleting(true)}>
                  <Trash2 />
                </Button>
              </div>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                <Lock className="size-3" /> {t('Maintained by the IT team')}
              </span>
            ))}
        </div>
        <CardBody className="px-5 py-4">{d.body.trim() ? <Markdown source={d.body} /> : <p className="text-[13px] italic text-muted">{t('This page is empty.')}</p>}</CardBody>
      </Card>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this page?"
        description="The page is removed for your colleagues and the IT team."
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

const TEMPLATES: { label: string; title: string; body: string }[] = [
  { label: 'Blank page', title: '', body: '' },
  {
    label: 'Office & contacts',
    title: 'Our office',
    body: '## Address\n\n\n## Opening hours\n\n\n## Important contacts\n\n| Role | Name | Phone | E-mail |\n| --- | --- | --- | --- |\n| Manager |  |  |  |\n| Reception |  |  |  |\n\n## Access (keys, alarm, parking)\n\n',
  },
  {
    label: 'Internet & suppliers',
    title: 'Internet and suppliers',
    body: '## Internet provider\n\n- Provider:\n- Customer number:\n- Support phone:\n\n## Other suppliers\n\n| Supplier | What for | Contact |\n| --- | --- | --- |\n|  |  |  |\n',
  },
  {
    label: 'Software we use',
    title: 'Software we use',
    body: '| Software | Used by | What for | Supplier / support |\n| --- | --- | --- | --- |\n|  |  |  |  |\n',
  },
  { label: 'Procedure', title: 'How to …', body: '## When\n\n\n## Steps\n\n1. \n2. \n3. \n\n## Who to contact\n\n' },
  {
    label: 'New employee checklist',
    title: 'New employee checklist',
    body: '- [ ] Ask the IT team for an account (open a request 5 working days before)\n- [ ] Laptop / phone\n- [ ] E-mail and shared mailboxes\n- [ ] Access to folders and software\n- [ ] Badge / keys\n',
  },
];

function DocEditor() {
  const params = useParams();
  const id = params.id ? Number(params.id) : null;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ['portal-doc', 'docs', id], queryFn: () => papi<Doc>('GET', `/docs/${id}`), enabled: id !== null });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [loaded, setLoaded] = useState(id === null);
  useEffect(() => {
    if (existing.data && !loaded) {
      setTitle(existing.data.title);
      setBody(existing.data.body);
      setLoaded(true);
    }
  }, [existing.data, loaded]);
  const save = useMutation({
    mutationFn: () => (id ? papi('PATCH', `/docs/${id}`, { title, body }).then(() => ({ id })) : papi<{ id: number }>('POST', '/docs', { title, body })),
    onSuccess: (r) => {
      toast.success(t('Page saved'));
      qc.invalidateQueries({ queryKey: ['portal-docs'] });
      qc.invalidateQueries({ queryKey: ['portal-doc'] });
      navigate(`/portal/docs/${r.id}`, { replace: true });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (id !== null && existing.isLoading) return <PageLoader />;
  if (id !== null && existing.data && !existing.data.canEdit) return <Navigate to={`/portal/docs/${id}`} replace />;
  const isNew = id === null;
  return (
    <div className="space-y-4">
      <Link to={id ? `/portal/docs/${id}` : '/portal/docs'} className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
        <ArrowLeft className="size-3" /> {t('Back')}
      </Link>
      <h1 className="text-lg font-semibold">{isNew ? t('New documentation page') : t('Edit page')}</h1>
      {isNew && !title && !body && (
        <div>
          <div className="mb-1.5 text-[12px] text-muted">{t('Start from a template:')}</div>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.label}
                onClick={() => {
                  setTitle(t(tpl.title));
                  setBody(tpl.body);
                }}
                className="cursor-pointer rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] hover:border-border-strong hover:bg-surface-2"
              >
                {t(tpl.label)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-[12px] text-warning">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" /> {t('Do not write passwords here. Ask the IT team to store them safely.')}
      </div>
      <Card>
        <CardBody className="space-y-3">
          <div>
            <Label htmlFor="doc-title">{t('Title')}</Label>
            <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} autoFocus={!isNew} />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1">
              <Label className="mb-0 flex-1">{t('Content')}</Label>
              <button onClick={() => setPreview(false)} className={cn('cursor-pointer rounded px-2 py-0.5 text-[12px]', !preview ? 'bg-primary-soft text-primary' : 'text-muted hover:text-foreground')}>
                <Pencil className="mr-1 inline size-3" />
                {t('Write')}
              </button>
              <button onClick={() => setPreview(true)} className={cn('cursor-pointer rounded px-2 py-0.5 text-[12px]', preview ? 'bg-primary-soft text-primary' : 'text-muted hover:text-foreground')}>
                <Eye className="mr-1 inline size-3" />
                {t('Preview')}
              </button>
            </div>
            {preview ? (
              <div className="min-h-64 rounded-md border border-border p-4">{body.trim() ? <Markdown source={body} /> : <p className="text-[13px] italic text-muted">{t('Nothing to preview yet.')}</p>}</div>
            ) : (
              <Textarea rows={18} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-[13px]" placeholder={t('Write here. Tips: ## Heading, - list item, **bold**, | tables |')} />
            )}
            <p className="mt-1 text-[11px] text-muted">{t('Formatting: ## heading · **bold** · - list · 1. numbered list · [link](https://…) · tables with |')}</p>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button variant="primary" disabled={title.trim().length < 2} loading={save.isPending} onClick={() => save.mutate()}>
              <Save /> Save page
            </Button>
            <Button variant="ghost" onClick={() => navigate(id ? `/portal/docs/${id}` : '/portal/docs')}>
              Cancel
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Eye, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { KB_STATUS } from '@taskora/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, PageLoader } from '@/components/ui/misc';
import { ConfirmDialog } from '@/components/ui/overlays';
import { Markdown } from '@/components/kb/markdown';
import { Attachments } from '@/pages/tickets/detail';
import { handleFormError } from '@/components/form';
import { TicketLink } from '@/lib/open-ticket';

export interface Article {
  id: number;
  articleNumber: string;
  title: string;
  body: string;
  categoryId: number | null;
  categoryName: string | null;
  companyId: number | null;
  companyName: string | null;
  tags: string[];
  visibility: 'internal' | 'public';
  status: 'draft' | 'published' | 'archived';
  views: number;
  authorName: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tickets: { id: number; ticketNumber: string; title: string }[];
}

export default function ArticlePage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [deleting, setDeleting] = useState(false);
  const q = useQuery({ queryKey: ['kb-article', id], queryFn: () => api.get<Article>(`/kb/articles/${id}`, { view: 'true' }), staleTime: 60_000 });
  const publish = useMutation({
    mutationFn: (status: string) => api.patch(`/kb/articles/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-article', id] });
      qc.invalidateQueries({ queryKey: ['kb'] });
    },
    onError: (e) => handleFormError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/kb/articles/${id}`),
    onSuccess: () => {
      toast.success('Article deleted');
      navigate('/kb');
    },
  });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <EmptyState title="Article not found" />;
  const a = q.data;
  const back = a.companyId ? { label: 'Documentation', to: '/documentation' } : { label: 'Knowledge Base', to: '/kb' };
  return (
    <div>
      <PageHeader
        title={a.title}
        icon={<BookOpen />}
        breadcrumbs={[back, { label: a.articleNumber }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={a.status === 'published' ? 'success' : 'warning'}>{KB_STATUS.labels[a.status]}</Badge>
            <Badge tone={a.visibility === 'public' ? 'info' : 'neutral'}>{a.visibility === 'public' ? 'Public' : 'Internal'}</Badge>
            {a.categoryName && <span>{a.categoryName}</span>}
            {a.companyName && (
              <Link to={`/companies/${a.companyId}`} className="text-primary hover:underline">
                {a.companyName}
              </Link>
            )}
          </span>
        }
        actions={
          can('kb.write') && (
            <>
              {a.status !== 'published' ? (
                <Button variant="primary" onClick={() => publish.mutate('published')} loading={publish.isPending}>
                  Publish
                </Button>
              ) : (
                <Button onClick={() => publish.mutate('archived')} loading={publish.isPending}>
                  Archive
                </Button>
              )}
              <Button onClick={() => navigate(`/kb/${id}/edit`)}>
                <Pencil /> Edit
              </Button>
              <Button variant="ghost" onClick={() => setDeleting(true)} aria-label="Delete article">
                <Trash2 />
              </Button>
            </>
          )
        }
      />
      <div className="grid gap-4 p-5 xl:grid-cols-[1fr_300px]">
        <Card>
          <CardBody className="px-8 py-6">
            <Markdown source={a.body} className="max-w-3xl text-[14px]" />
          </CardBody>
        </Card>
        <aside className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="grid grid-cols-2 gap-3">
                <Field label="Number">{a.articleNumber}</Field>
                <Field label="Author">{a.authorName}</Field>
                <Field label="Published">{a.publishedAt ? fmtDateTime(a.publishedAt) : null}</Field>
                <Field label="Updated">{fmtDateTime(a.updatedAt)}</Field>
                <Field label="Views">
                  <span className="inline-flex items-center gap-1">
                    <Eye className="size-3" /> {a.views}
                  </span>
                </Field>
              </dl>
              {a.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {a.tags.map((t) => (
                    <Link key={t} to={`/kb?tag=${encodeURIComponent(t)}`}>
                      <Badge tone="primary">#{t}</Badge>
                    </Link>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Linked tickets" />
            <CardBody>
              {a.tickets.length === 0 ? (
                <p className="text-xs text-muted">Not linked to any ticket yet. Link articles from the ticket workspace.</p>
              ) : (
                <ul className="space-y-1.5 text-[13px]">
                  {a.tickets.map((t) => (
                    <li key={t.id}>
                      <TicketLink ticketId={t.id} className="hover:text-primary">
                        <span className="font-mono text-xs text-muted">{t.ticketNumber}</span> {t.title}
                      </TicketLink>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Attachments" />
            <CardBody>
              <Attachments entityType="kb_article" entityId={id} canWrite={can('kb.write')} />
            </CardBody>
          </Card>
        </aside>
      </div>
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title="Delete this article?" danger confirmLabel="Delete" loading={remove.isPending} onConfirm={() => remove.mutate()} />
    </div>
  );
}

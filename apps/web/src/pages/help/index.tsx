import { useMemo, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, CircleHelp, Search } from 'lucide-react';
import { PageHeader } from '@/components/page';
import { Markdown } from '@/components/kb/markdown';
import { Input } from '@/components/ui/input';
import { Card, CardBody, EmptyState } from '@/components/ui/misc';
import { HELP_ARTICLES, type HelpArticle } from './articles';

const GROUPS: HelpArticle['group'][] = ['Start here', 'Daily work', 'Customers & assets', 'Business', 'Administration', 'Automation'];

export default function HelpPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const article = slug ? HELP_ARTICLES.find((a) => a.slug === slug) : null;
  const needle = q.trim().toLowerCase();
  const list = useMemo(
    () => HELP_ARTICLES.filter((a) => !needle || `${a.title} ${a.summary} ${a.body}`.toLowerCase().includes(needle)),
    [needle],
  );

  // Internal links in articles (/settings…) navigate inside the app instead of a new tab.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (a && href && href.startsWith('/') && !href.startsWith('//')) {
      e.preventDefault();
      navigate(href);
    }
  };

  if (slug && !article) return <EmptyState title="Guide not found" action={<Link to="/help">All guides</Link>} />;

  return (
    <div>
      <PageHeader title={article ? article.title : 'Help & Guides'} icon={<CircleHelp />} subtitle={article ? article.summary : 'How to use Taskora, step by step'} />
      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
            <Input className="pl-8" placeholder="Search the guides…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {GROUPS.map((g) => {
            const items = list.filter((a) => a.group === g);
            if (!items.length) return null;
            return (
              <nav key={g}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">{g}</div>
                <ul className="space-y-0.5">
                  {items.map((a) => (
                    <li key={a.slug}>
                      <Link
                        to={`/help/${a.slug}`}
                        className={`block rounded px-2 py-1 text-[13px] hover:bg-surface-2 ${a.slug === slug ? 'bg-primary/10 font-medium text-primary' : ''}`}
                      >
                        {a.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            );
          })}
        </aside>
        <main className="min-w-0">
          {article ? (
            <Card>
              <CardBody>
                <Link to="/help" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
                  <ArrowLeft className="size-3" /> All guides
                </Link>
                <div onClick={onClick}>
                  <Markdown source={article.body.trim()} className="max-w-3xl" />
                </div>
              </CardBody>
            </Card>
          ) : list.length === 0 ? (
            <EmptyState title="No guide matches your search" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((a) => (
                <Link key={a.slug} to={`/help/${a.slug}`} className="group rounded-lg border border-border bg-surface p-4 transition hover:border-primary/50 hover:shadow-sm">
                  <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold group-hover:text-primary">
                    <BookOpen className="size-4 text-primary" /> {a.title}
                  </div>
                  <p className="text-xs text-muted">{a.summary}</p>
                  <div className="mt-2 text-[11px] uppercase tracking-wide text-subtle">{a.group}</div>
                </Link>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

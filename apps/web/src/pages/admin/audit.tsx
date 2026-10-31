import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { api, type Paginated } from '@/lib/api';
import { useLookups, userOpts } from '@/lib/lookups';
import { fmtDateTime } from '@/lib/utils';
import { useTableState } from '@/hooks/use-table-state';
import { DataTable, type Column } from '@/components/data-table';
import { FilterSelect, ListLayout, PageHeader, SearchInput } from '@/components/page';
import { Badge } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/overlays';
import { Input } from '@/components/ui/input';

interface Row {
  id: number;
  at: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  changes: Record<string, unknown> | null;
  ip: string | null;
  userName: string | null;
}

const LINKS: Record<string, string> = {
  company: '/companies/',
  contact: '/contacts/',
  ticket: '/tickets/',
  configuration_item: '/assets/',
  contract: '/contracts/',
  project: '/projects/',
  kb_article: '/kb/',
  invoice: '/invoices/',
};

const TONE: Record<string, 'success' | 'info' | 'danger' | 'warning' | 'neutral'> = { create: 'success', update: 'info', delete: 'danger', login_failed: 'warning', sync: 'info' };

function fmtVal(v: unknown) {
  if (v === null || v === undefined || v === '') return <span className="text-subtle">empty</span>;
  if (typeof v === 'object') return <code className="text-[11px]">{JSON.stringify(v)}</code>;
  return String(v);
}

export default function AuditPage() {
  const lookups = useLookups();
  const t = useTableState();
  const [open, setOpen] = useState<Row | null>(null);
  const list = useQuery({ queryKey: ['audit', t.query], queryFn: () => api.get<Paginated<Row>>('/audit-logs', t.query), placeholderData: keepPreviousData });
  const cols: Column<Row>[] = [
    { header: 'Time', cell: ({ row }) => <span className="whitespace-nowrap text-xs">{fmtDateTime(row.original.at)}</span> },
    { header: 'User', cell: ({ row }) => row.original.userName ?? <span className="text-subtle">System</span> },
    { header: 'Action', cell: ({ row }) => <Badge tone={TONE[row.original.action] ?? 'neutral'}>{row.original.action.replace('_', ' ')}</Badge> },
    {
      header: 'Record',
      cell: ({ row }) => {
        const base = LINKS[row.original.entityType];
        const label = `${row.original.entityType.replace(/_/g, ' ')}${row.original.entityId ? ` #${row.original.entityId}` : ''}`;
        return base && row.original.entityId && row.original.action !== 'delete' ? (
          <Link to={base + row.original.entityId} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
            {label}
          </Link>
        ) : (
          label
        );
      },
    },
    { header: 'Summary', cell: ({ row }) => <span className="line-clamp-1 text-muted">{row.original.summary ?? (row.original.changes ? `${Object.keys(row.original.changes).length} field(s) changed` : '')}</span> },
    { header: 'IP', cell: ({ row }) => <span className="font-mono text-[11px] text-muted">{row.original.ip ?? ''}</span> },
  ];
  const changes = open?.changes ?? null;
  return (
    <ListLayout
      header={<PageHeader title="Audit Logs" icon={<ScrollText />} subtitle="Who changed what, and when" />}
      toolbar={
        <>
          <SearchInput value={t.q} onChange={t.setQ} placeholder="Search summaries…" />
          <FilterSelect
            value={t.filters.action}
            onChange={(v) => t.setFilter('action', v)}
            placeholder="Any action"
            options={['create', 'update', 'delete', 'login', 'logout', 'login_failed', 'sync'].map((a) => ({ value: a, label: a.replace('_', ' ') }))}
          />
          <FilterSelect
            value={t.filters.entityType}
            onChange={(v) => t.setFilter('entityType', v)}
            placeholder="Any record type"
            options={['ticket', 'company', 'contact', 'configuration_item', 'contract', 'project', 'time_entry', 'invoice', 'user', 'role', 'integration', 'workflow_rule', 'kb_article', 'system_settings'].map((e) => ({ value: e, label: e.replace(/_/g, ' ') }))}
          />
          <FilterSelect value={t.filters.userId} onChange={(v) => t.setFilter('userId', v)} placeholder="Any user" options={userOpts(lookups.data?.users, null, false)} />
          <Input type="date" value={t.filters.from ?? ''} onChange={(e) => t.setFilter('from', e.target.value)} className="w-40" aria-label="From" />
          <Input type="date" value={t.filters.to ?? ''} onChange={(e) => t.setFilter('to', e.target.value ? `${e.target.value}T23:59:59` : '')} className="w-40" aria-label="To" />
        </>
      }
    >
      <DataTable className="h-full" columns={cols} data={list.data?.data} total={list.data?.total} page={t.page} pageSize={t.pageSize} loading={list.isLoading} onPageChange={t.setPage} onRowClick={(r) => setOpen(r)} />
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open ? `${open.action} · ${open.entityType}${open.entityId ? ` #${open.entityId}` : ''}` : ''} description={open ? `${open.userName ?? 'System'} · ${fmtDateTime(open.at)} · ${open.ip ?? ''}` : ''} size="lg">
        {open?.summary && <p className="mb-3 text-[13px]">{open.summary}</p>}
        {changes && Object.keys(changes).length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="py-1">Field</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(changes).map(([k, v]) => (
                  <tr key={k} className="border-t border-border align-top">
                    <td className="py-1.5 pr-3 font-medium">{k}</td>
                    {Array.isArray(v) && v.length === 2 ? (
                      <>
                        <td className="pr-3 text-muted">{fmtVal(v[0])}</td>
                        <td>{fmtVal(v[1])}</td>
                      </>
                    ) : (
                      <td colSpan={2}>{fmtVal(v)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-muted">No field-level changes recorded.</p>
        )}
      </Dialog>
    </ListLayout>
  );
}

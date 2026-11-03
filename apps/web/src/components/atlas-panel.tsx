import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { Badge, Card, CardBody, CardHeader, Field, Skeleton } from './ui/misc';

export interface AtlasEntity {
  id: number;
  instance: string;
  entityKey: string;
  kind: string;
  name: string;
  hostname: string | null;
  ipAddresses: string[];
  macAddresses: string[];
  pveCluster: string | null;
  pveNode: string | null;
  vmid: number | null;
  status: string;
  osName: string | null;
  link: string | null;
  data: Record<string, unknown>;
  matchStatus: string;
  matchNote: string | null;
  previousNames: string[];
  observedAt: string | null;
  missingSince: string | null;
  freshness: 'fresh' | 'stale' | 'missing' | 'decommissioned' | 'unknown';
}

interface CiPanel {
  entity: AtlasEntity | null;
  incidents: { key: string; title: string; state: string; severity: string; ticketId: number | null; at: string }[];
  relations: { type: string; detail: string | null; observedAt: string | null; related: string; relatedName: string; relatedId: number }[];
  atlasBaseUrl: string | null;
}

interface TicketPanel {
  link: {
    externalKey: string;
    state: string;
    severity: string;
    persisting: boolean;
    revision: number;
    title: string;
    link: string | null;
    details: { checks?: { name: string; state: string; detail: string }[]; evidence?: string[]; recentChanges?: string[]; summary?: string };
    firstObservedAt: string;
    lastObservedAt: string;
    resolvedAt: string | null;
  } | null;
  entity: AtlasEntity | null;
  atlasBaseUrl: string | null;
}

export const severityTone = (s: string) => (s === 'warning' ? 'danger' : s === 'notice' ? 'warning' : 'info') as 'danger' | 'warning' | 'info';
export const freshnessTone = (f: string) => (f === 'fresh' ? 'success' : f === 'stale' || f === 'missing' ? 'warning' : 'neutral') as 'success' | 'warning' | 'neutral';
const stateTone = (s: string) => (s === 'resolved' ? 'success' : s === 'acknowledged' ? 'info' : 'danger') as 'success' | 'info' | 'danger';
const checkTone = (s: string) => (s === 'pass' ? 'text-success' : s === 'fail' ? 'text-danger' : s === 'warn' ? 'text-warning' : 'text-muted');

/** Only http(s) links from atlas are rendered as links (atlas data is untrusted). */
export function safeHref(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function Placement({ e }: { e: AtlasEntity }) {
  const where = [e.pveCluster, e.pveNode, e.vmid ? `VMID ${e.vmid}` : null].filter(Boolean).join(' · ');
  const net = [e.data.network, e.data.vlan != null ? `VLAN ${e.data.vlan}` : null, e.data.uplink].filter(Boolean).join(' · ');
  return (
    <>
      <Field label="Kind">{e.kind}</Field>
      {where && <Field label="Proxmox">{where}</Field>}
      <Field label="IP addresses">{e.ipAddresses.join(', ') || null}</Field>
      {net && <Field label="Network">{net}</Field>}
    </>
  );
}

/** What atlas observes about a configuration item. Read-only: atlas owns these observations. */
export function AtlasCiPanel({ ciId }: { ciId: number }) {
  const q = useQuery({ queryKey: ['ci-atlas', ciId], queryFn: () => api.get<CiPanel>(`/configuration-items/${ciId}/atlas`) });
  if (q.isLoading) return <Skeleton className="h-20 w-full" />;
  const p = q.data;
  if (!p?.entity && !p?.incidents.length) return <p className="text-xs text-muted">Not observed by atlas.</p>;
  const e = p.entity;
  const apps = (e?.data.apps as { name: string; version?: string }[] | undefined) ?? [];
  return (
    <div className="space-y-3">
      {e && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={freshnessTone(e.freshness)}>{e.freshness}</Badge>
            <Badge>{e.status}</Badge>
            {e.previousNames.length > 0 && <Badge>was {e.previousNames.join(', ')}</Badge>}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 lg:grid-cols-3">
            <Placement e={e} />
            <Field label="Observed">{e.observedAt ? <span title={fmtDateTime(e.observedAt)}>{fmtRelative(e.observedAt)}</span> : null}</Field>
            <Field label="atlas key">
              <span className="font-mono text-[11px]">{e.entityKey}</span>
            </Field>
          </dl>
          {apps.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {apps.slice(0, 30).map((a) => (
                <Badge key={a.name}>{a.version ? `${a.name} ${a.version}` : a.name}</Badge>
              ))}
            </div>
          )}
        </>
      )}
      {p.relations.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">Observed relations</div>
          <ul className="space-y-1 text-[12px]">
            {p.relations.map((r) => (
              <li key={`${r.type}-${r.relatedId}`}>
                {r.type.replace('_', ' ')}{' '}
                <Link className="hover:text-primary" to={`/assets/${r.relatedId}`}>
                  {r.relatedName}
                </Link>
                {r.detail && <span className="text-muted"> ({r.detail})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.incidents.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">atlas incidents</div>
          <ul className="space-y-1 text-[12px]">
            {p.incidents.map((i) => (
              <li key={i.key} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {i.ticketId ? (
                    <Link className="hover:text-primary" to={`/tickets/${i.ticketId}`}>
                      {i.title}
                    </Link>
                  ) : (
                    i.title
                  )}
                </span>
                <Badge tone={stateTone(i.state)}>{i.state}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {safeHref(e?.link) && (
        <a href={safeHref(e?.link)!} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink className="size-3" /> Open in atlas
        </a>
      )}
    </div>
  );
}

/** Card wrapper for tickets atlas created (tagged `atlas`); renders nothing for other tickets. */
export function AtlasTicketCard({ ticketId }: { ticketId: number }) {
  return (
    <Card>
      <CardHeader title="atlas incident" description="Observed state (atlas-owned, read-only)" />
      <CardBody>
        <AtlasTicketPanel ticketId={ticketId} />
      </CardBody>
    </Card>
  );
}

/** The atlas incident behind a ticket: live state, checks and evidence (atlas-owned, read-only). */
export function AtlasTicketPanel({ ticketId }: { ticketId: number }) {
  const q = useQuery({ queryKey: ['ticket-atlas', ticketId], queryFn: () => api.get<TicketPanel>(`/tickets/${ticketId}/atlas`) });
  if (q.isLoading) return <Skeleton className="h-16 w-full" />;
  if (!q.data?.link) return <p className="text-xs text-muted">No atlas incident is linked to this ticket.</p>;
  const l = q.data.link;
  const href = safeHref(l.link);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={stateTone(l.state)}>
          <Activity className="size-3" /> {l.state}
        </Badge>
        <Badge tone={severityTone(l.severity)}>{l.severity}</Badge>
        {l.persisting && (
          <Badge tone="danger">
            <AlertTriangle className="size-3" /> Still failing
          </Badge>
        )}
      </div>
      {l.persisting && <p className="text-xs text-danger">The ticket was resolved, but atlas still observes the problem. Only atlas confirms recovery.</p>}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label="First observed">{fmtDateTime(l.firstObservedAt)}</Field>
        <Field label="Last observed">{fmtRelative(l.lastObservedAt)}</Field>
        {l.resolvedAt && <Field label="Recovered">{fmtDateTime(l.resolvedAt)}</Field>}
        {q.data.entity && <Field label="Affected">{q.data.entity.name}</Field>}
      </dl>
      {(l.details.checks ?? []).length > 0 && (
        <ul className="space-y-0.5 text-[12px]">
          {l.details.checks!.map((c) => (
            <li key={c.name}>
              <span className={`font-medium ${checkTone(c.state)}`}>{c.state}</span> {c.name}
              {c.detail && <span className="text-muted"> — {c.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {(l.details.evidence ?? []).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-muted">
          {l.details.evidence!.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {href && (
        <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <ExternalLink className="size-3" /> Open in atlas
        </a>
      )}
    </div>
  );
}

import { AlertTriangle, CheckCircle2, Clock, PauseCircle, XCircle } from 'lucide-react';
import { Badge, Dot } from './ui/misc';
import { Tooltip } from './ui/overlays';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { translate as t } from '@/lib/i18n';

export function StatusBadge({ name, color }: { name?: string | null; color?: string | null }) {
  if (!name) return null;
  return (
    <Badge color={color}>
      <Dot color={color} className="size-1.5" />
      {name}
    </Badge>
  );
}

export function PriorityBadge({ name, color, level }: { name?: string | null; color?: string | null; level?: number | null }) {
  if (!name) return null;
  const bars = level ? Math.max(1, 5 - level) : 0;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium" style={{ color: color ?? undefined }}>
      <span className="flex items-end gap-px" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className="w-[3px] rounded-sm" style={{ height: 3 + i * 2, backgroundColor: i <= bars ? (color ?? 'currentColor') : 'var(--border-strong)' }} />
        ))}
      </span>
      <span className="text-foreground">{name}</span>
    </span>
  );
}

export type SlaState = 'none' | 'pending' | 'at_risk' | 'breached' | 'met' | 'met_late' | 'paused';

const SLA: Record<SlaState, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; icon: typeof Clock }> = {
  none: { label: 'No SLA', tone: 'neutral', icon: Clock },
  pending: { label: 'On track', tone: 'info', icon: Clock },
  at_risk: { label: 'At risk', tone: 'warning', icon: AlertTriangle },
  breached: { label: 'Breached', tone: 'danger', icon: XCircle },
  met: { label: 'Met', tone: 'success', icon: CheckCircle2 },
  met_late: { label: 'Met late', tone: 'warning', icon: CheckCircle2 },
  paused: { label: 'Paused', tone: 'neutral', icon: PauseCircle },
};

export function SlaBadge({ state, due, compact }: { state: SlaState; due?: string | null; compact?: boolean }) {
  const s = SLA[state] ?? SLA.none;
  const Icon = s.icon;
  const badge = (
    <Badge tone={s.tone}>
      <Icon className="size-3" />
      {compact ? null : t(s.label)}
      {due && (state === 'pending' || state === 'at_risk' || state === 'breached') && <span className="font-normal opacity-80">{fmtRelative(due)}</span>}
    </Badge>
  );
  return due ? <Tooltip content={t('Due {date}', { date: fmtDateTime(due) })}>{badge}</Tooltip> : badge;
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <Badge tone="success">{t('Active')}</Badge> : <Badge>{t('Inactive')}</Badge>;
}

const LIFECYCLE_TONE: Record<string, 'success' | 'neutral' | 'warning' | 'info' | 'danger'> = {
  active: 'success',
  planned: 'info',
  in_stock: 'info',
  in_repair: 'warning',
  retired: 'neutral',
  disposed: 'neutral',
};
export function LifecycleBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={LIFECYCLE_TONE[status] ?? 'neutral'}>{label ?? status.replace('_', ' ')}</Badge>;
}

/** Action1 agent state: Connected / Disconnected (+ online status SUCCESS/WARNING/ERROR). */
export function DeviceStateBadge({ agentStatus, onlineStatus }: { agentStatus?: string | null; onlineStatus?: string | null }) {
  if (!agentStatus && !onlineStatus) return null;
  const connected = agentStatus === 'Connected';
  return (
    <Badge tone={connected ? 'success' : agentStatus === 'Disconnected' ? 'danger' : 'neutral'}>
      <Dot color={connected ? 'var(--success)' : agentStatus === 'Disconnected' ? 'var(--danger)' : 'var(--subtle)'} className="size-1.5" />
      {agentStatus ?? onlineStatus}
    </Badge>
  );
}

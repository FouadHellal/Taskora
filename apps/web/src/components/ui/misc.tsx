import type { HTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { translate, translateNode } from '@/lib/i18n';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-surface shadow-card', className)} {...props} />;
}

export function CardHeader({ title, actions, description, className }: { title: ReactNode; actions?: ReactNode; description?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-2 border-b border-border px-4 py-2.5', className)}>
      <div className="min-w-0">
        <h3 className="truncate text-[13px] font-semibold">{translateNode(title)}</h3>
        {description && <p className="text-xs text-muted">{translateNode(description)}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

const tones = {
  neutral: 'bg-surface-2 text-muted border-border',
  primary: 'bg-primary-soft text-primary border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};
export type Tone = keyof typeof tones;

export function Badge({ tone = 'neutral', className, children, color, ...props }: Omit<HTMLAttributes<HTMLSpanElement>, 'color'> & { tone?: Tone; color?: string | null }) {
  const style = color ? { backgroundColor: `${color}1f`, color, borderColor: `${color}40` } : undefined;
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[11px] font-medium leading-none', !color && tones[tone], className)}
      style={style}
      {...props}
    >
      {children}
    </span>
  );
}

export function Dot({ color, className }: { color?: string | null; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ backgroundColor: color ?? 'var(--subtle)' }} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-surface-2', className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-subtle [&_svg]:size-8">{icon}</div>}
      <p className="text-sm font-medium">{translate(title)}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-muted">{translateNode(description)}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border-strong bg-surface-2 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function Avatar({ name, className }: { name?: string | null; className?: string }) {
  const initials = (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  // Stable hue per name.
  let h = 0;
  for (const c of name ?? '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white', className)}
      style={{ backgroundColor: `hsl(${h} 45% 48%)` }}
      title={name ?? undefined}
    >
      {initials || '?'}
    </span>
  );
}

/** Label/value pair used in record side panels. */
export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-subtle">{translate(label)}</dt>
      <dd className="mt-0.5 truncate text-[13px]">{children ?? <span className="text-subtle">—</span>}</dd>
    </div>
  );
}

export function Stat({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; onClick?: () => void }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-foreground';
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={cn('rounded-lg border border-border bg-surface px-3.5 py-2.5 text-left shadow-card', onClick && 'cursor-pointer transition-colors hover:border-border-strong')}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{translate(label)}</div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', color)}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted">{translateNode(hint)}</div>}
    </Comp>
  );
}

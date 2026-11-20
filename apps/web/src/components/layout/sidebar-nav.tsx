import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { translate as t } from '@/lib/i18n';
import { isActive, isGroup, NAV, type NavGroup, type NavItem, type NavSection } from './nav';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger, Tooltip } from '../ui/overlays';

const OPEN_KEY = 'taskora-nav-open';
const DEFAULT_OPEN = ['Workspace', 'Service Desk', 'Service Desk/Tickets'];

type Counts = Record<string, number> | undefined;

function readOpen(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : DEFAULT_OPEN;
  } catch {
    return DEFAULT_OPEN;
  }
}

/** The section/group keys that contain the current page (prefix match, so detail pages count). */
function activeKeys(sections: NavSection[], pathname: string): string[] {
  for (const s of sections) {
    for (const e of s.items) {
      if (isGroup(e) ? e.children.some((c) => isActive(c, pathname, false)) : isActive(e, pathname, false)) {
        return isGroup(e) ? [s.label, `${s.label}/${e.label}`] : [s.label];
      }
    }
  }
  return [];
}

function CountBadge({ item, counts }: { item: NavItem; counts: Counts }) {
  const n = item.badge ? counts?.[item.badge] : undefined;
  if (!n) return null;
  return (
    <span className={cn('ml-auto rounded px-1.5 text-[10px] font-semibold tabular-nums', item.badge === 'breached' ? 'bg-red-500/20 text-red-300' : 'bg-white/10 text-sidebar-fg')}>{n}</span>
  );
}

function ItemLink({ item, counts, nested }: { item: NavItem; counts: Counts; nested?: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive: active }) =>
        cn(
          'group flex h-7 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors hover:bg-sidebar-active hover:text-white',
          nested && 'ml-3.5 border-l border-white/10 pl-3 rounded-l-none',
          active && 'bg-sidebar-active font-medium text-white',
        )
      }
    >
      <Icon className={cn('shrink-0 opacity-80', nested ? 'size-3.5' : 'size-4')} />
      <span className="truncate">{t(item.label)}</span>
      <CountBadge item={item} counts={counts} />
    </NavLink>
  );
}

function GroupRow({ group, open, onToggle, counts, active }: { group: NavGroup; open: boolean; onToggle: () => void; counts: Counts; active: boolean }) {
  const Icon = group.icon;
  // While folded, surface the first non-zero badge of the group.
  const badged = open ? undefined : group.children.find((c) => c.badge && counts?.[c.badge]);
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors hover:bg-sidebar-active hover:text-white',
          active && !open && 'text-white',
        )}
      >
        <Icon className="size-4 shrink-0 opacity-80" />
        <span className="truncate">{t(group.label)}</span>
        {badged && <CountBadge item={badged} counts={counts} />}
        <ChevronRight className={cn('size-3.5 shrink-0 opacity-50 transition-transform', !badged && 'ml-auto', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {group.children.map((c) => (
            <ItemLink key={c.to} item={c} counts={counts} nested />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Main navigation. Expanded: collapsible sections with nested sub-menus,
 * the section of the current page opens automatically. Compact: one icon
 * per section that opens its menu as a flyout.
 */
export function SidebarNav({ collapsed, counts }: { collapsed: boolean; counts: Counts }) {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const allowed = (i: NavItem) => !i.perm || can(i.perm);

  const sections = useMemo(
    () =>
      NAV.map((s) => ({
        ...s,
        items: s.items
          .map((e) => (isGroup(e) ? { ...e, children: e.children.filter(allowed) } : e))
          .filter((e) => (isGroup(e) ? e.children.length > 0 : allowed(e))),
      })).filter((s) => s.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [can],
  );

  const [open, setOpen] = useState<Set<string>>(() => new Set(readOpen()));
  const current = useMemo(() => activeKeys(sections, pathname), [sections, pathname]);

  // Reveal the current page when navigating (without closing anything).
  useEffect(() => {
    if (current.every((k) => open.has(k))) return;
    setOpen((o) => new Set([...o, ...current]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
    } catch {
      /* ignore */
    }
  }, [open]);

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  if (collapsed) {
    return (
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-3 scrollbar-thin" aria-label={t('Main')}>
        {sections.map((s) => {
          const Icon = s.icon;
          const here = current[0] === s.label;
          const breached = s.items.some((e) => !isGroup(e) && e.badge === 'breached' && counts?.breached);
          return (
            <DropdownMenu key={s.label}>
              <Tooltip content={s.label} side="right">
                <DropdownTrigger asChild>
                  <button
                    type="button"
                    aria-label={t(s.label)}
                    className={cn(
                      'relative flex size-9 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-sidebar-active hover:text-white',
                      here && 'bg-sidebar-active text-white',
                    )}
                  >
                    <Icon className="size-[18px]" />
                    {breached && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-red-400" />}
                  </button>
                </DropdownTrigger>
              </Tooltip>
              <DropdownContent side="right" align="start" className="min-w-52">
                <DropdownLabel>{s.label}</DropdownLabel>
                {s.items.map((e, i) =>
                  isGroup(e) ? (
                    <div key={e.label}>
                      {i > 0 && <DropdownSeparator />}
                      <DropdownLabel>{e.label}</DropdownLabel>
                      {e.children.map((c) => (
                        <FlyoutItem key={c.to} item={c} counts={counts} active={isActive(c, pathname)} onSelect={() => navigate(c.to)} />
                      ))}
                    </div>
                  ) : (
                    <FlyoutItem key={e.to} item={e} counts={counts} active={isActive(e, pathname)} onSelect={() => navigate(e.to)} />
                  ),
                )}
              </DropdownContent>
            </DropdownMenu>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 scrollbar-thin" aria-label={t('Main')}>
      {sections.map((s) => {
        const isOpen = open.has(s.label);
        return (
          <div key={s.label} className="mt-2">
            <button
              type="button"
              onClick={() => toggle(s.label)}
              aria-expanded={isOpen}
              className={cn(
                'flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted hover:text-white',
                current[0] === s.label && !isOpen && 'text-white',
              )}
            >
              <span className="truncate">{t(s.label)}</span>
              <ChevronRight className={cn('ml-auto size-3 transition-transform', isOpen && 'rotate-90')} />
            </button>
            {isOpen && (
              <div className="space-y-0.5">
                {s.items.map((e) => {
                  if (!isGroup(e)) return <ItemLink key={e.to} item={e} counts={counts} />;
                  const key = `${s.label}/${e.label}`;
                  return <GroupRow key={key} group={e} open={open.has(key)} onToggle={() => toggle(key)} counts={counts} active={current[1] === key} />;
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function FlyoutItem({ item, counts, active, onSelect }: { item: NavItem; counts: Counts; active: boolean; onSelect: () => void }) {
  const Icon = item.icon;
  const n = item.badge ? counts?.[item.badge] : undefined;
  return (
    <DropdownItem onSelect={onSelect}>
      <Icon />
      <span className={cn('flex-1', active && 'font-semibold text-primary')}>{t(item.label)}</span>
      {!!n && <span className={cn('rounded px-1.5 text-[10px] font-semibold tabular-nums', item.badge === 'breached' ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-muted')}>{n}</span>}
    </DropdownItem>
  );
}

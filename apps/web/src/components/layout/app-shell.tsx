import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronsLeft, ChevronsRight, Laptop, LogOut, Mail, Menu, Moon, Plus, Search, Sun, Monitor, KeyRound, Keyboard, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth, useMe } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { SidebarNav } from './sidebar-nav';
import { logoUrl } from '../logo';
import { Avatar, Kbd } from '../ui/misc';
import { Button } from '../ui/button';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger } from '../ui/overlays';
import { CommandPalette } from './command-palette';
import { TimerWidget } from './timer-widget';
import { NotificationBell } from './notification-bell';
import { useTheme } from '@/hooks/use-theme';
import { useNarrow } from '@/hooks/use-media-query';
import { ShortcutsDialog, useGlobalShortcuts } from './shortcuts';
import { ChangePasswordDialog } from './change-password';
import { SessionsDialog } from './sessions';

function readCollapsed() {
  try {
    // Narrow screens start with the compact sidebar unless the user chose otherwise.
    const saved = localStorage.getItem('taskora-sidebar');
    if (!saved) return window.innerWidth < 1100;
    return saved === 'collapsed';
  } catch {
    return false;
  }
}

export function AppShell() {
  const me = useMe();
  const { can, logout, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const orgLogo = logoUrl('organization', 0, me.organization.logoUpdatedAt);
  const narrow = useNarrow();
  const [menuOpen, setMenuOpen] = useState(false);

  // The slide-in menu closes after navigating.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  useEffect(() => {
    try {
      localStorage.setItem('taskora-sidebar', collapsed ? 'collapsed' : 'expanded');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useGlobalShortcuts({ openPalette: () => setPaletteOpen(true), openHelp: () => setShortcutsOpen(true) });

  const counts = useQuery({
    queryKey: ['ticket-counts'],
    queryFn: () => api.get<Record<string, number>>('/tickets/counts'),
    enabled: can('tickets.read'),
    refetchInterval: 60_000,
  });

  const brand = (
    <div className="flex h-12 shrink-0 items-center gap-2 px-3.5">
      {orgLogo ? <img src={orgLogo} alt="" className="size-7 rounded bg-white object-contain p-0.5" /> : <img src="/favicon.svg" alt="" className="size-6" />}
      {(!collapsed || narrow) && <span className="truncate text-[15px] font-semibold tracking-tight text-white">{orgLogo ? me.organization.name : 'Taskora'}</span>}
    </div>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      {narrow ? (
        <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <DialogPrimitive.Content
              className="fixed inset-y-0 left-0 z-50 flex w-[min(18rem,85vw)] flex-col bg-sidebar pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-sidebar-fg shadow-2xl focus:outline-none"
              aria-describedby={undefined}
            >
              <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
              <div className="flex items-center justify-between pr-2">
                {brand}
                <DialogPrimitive.Close className="flex size-9 cursor-pointer items-center justify-center rounded-md text-sidebar-muted hover:text-white" aria-label="Close menu">
                  <X className="size-5" />
                </DialogPrimitive.Close>
              </div>
              <div className="nav-touch flex min-h-0 flex-1 flex-col">
                <SidebarNav collapsed={false} counts={counts.data} />
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      ) : (
        <aside className={cn('flex shrink-0 flex-col bg-sidebar text-sidebar-fg transition-[width] duration-150', collapsed ? 'w-14' : 'w-60')}>
          {brand}
          <SidebarNav collapsed={collapsed} counts={counts.data} />
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex h-9 shrink-0 cursor-pointer items-center gap-2 border-t border-white/5 px-4 text-xs text-sidebar-muted hover:text-white"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            {!collapsed && 'Collapse'}
          </button>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-2 sm:gap-3 sm:px-4">
          {narrow && (
            <Button variant="ghost" size="icon" onClick={() => setMenuOpen(true)} aria-label="Open menu">
              <Menu />
            </Button>
          )}
          {narrow ? (
            <Button variant="ghost" size="icon" onClick={() => setPaletteOpen(true)} aria-label="Search">
              <Search />
            </Button>
          ) : (
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex h-8 w-full max-w-md cursor-pointer items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-muted hover:border-border-strong"
            >
              <Search className="size-3.5" />
              <span className="flex-1 truncate text-left">Search tickets, companies, contacts, devices…</span>
              <Kbd>Ctrl K</Kbd>
            </button>
          )}
          <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
            {can('tickets.write') && (
              <Button variant="primary" size={narrow ? 'icon' : 'sm'} onClick={() => navigate('/tickets/new', { state: { from: location.pathname } })} aria-label="New ticket">
                <Plus /> {!narrow && 'New ticket'}
              </Button>
            )}
            {can('time.write') && <TimerWidget />}
            <NotificationBell />
            <DropdownMenu>
              <DropdownTrigger asChild>
                <button className="ml-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2" aria-label="Account menu">
                  <Avatar name={`${me.user.firstName} ${me.user.lastName}`} />
                  <span className="hidden text-left leading-tight md:block">
                    <span className="block text-[12px] font-medium">
                      {me.user.firstName} {me.user.lastName}
                    </span>
                    <span className="block text-[11px] text-muted">{me.user.roleName}</span>
                  </span>
                </button>
              </DropdownTrigger>
              <DropdownContent>
                <DropdownLabel>{me.organization.name}</DropdownLabel>
                <DropdownSeparator />
                <DropdownItem onSelect={() => setTheme('light')}>
                  <Sun /> Light {theme === 'light' && '✓'}
                </DropdownItem>
                <DropdownItem onSelect={() => setTheme('dark')}>
                  <Moon /> Dark {theme === 'dark' && '✓'}
                </DropdownItem>
                <DropdownItem onSelect={() => setTheme('system')}>
                  <Monitor /> System {theme === 'system' && '✓'}
                </DropdownItem>
                <DropdownSeparator />
                <DropdownItem onSelect={() => setShortcutsOpen(true)}>
                  <Keyboard /> Keyboard shortcuts
                </DropdownItem>
                {me.emailEnabled && (
                  <DropdownItem
                    onSelect={async () => {
                      await api.patch('/auth/preferences', { emailNotifications: me.preferences.emailNotifications === false });
                      await refresh();
                    }}
                  >
                    <Mail /> E-mail notifications: {me.preferences.emailNotifications === false ? 'off' : 'on'}
                  </DropdownItem>
                )}
                <DropdownItem onSelect={() => setSessionsOpen(true)}>
                  <Laptop /> Active sessions
                </DropdownItem>
                <DropdownItem onSelect={() => setPwOpen(true)}>
                  <KeyRound /> Change password
                </DropdownItem>
                <DropdownItem
                  onSelect={async () => {
                    await logout();
                    navigate('/login');
                  }}
                >
                  <LogOut /> Sign out
                </DropdownItem>
              </DropdownContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <SessionsDialog open={sessionsOpen} onOpenChange={setSessionsOpen} />
    </div>
  );
}

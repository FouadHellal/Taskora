import { useEffect, useRef, type MouseEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow } from 'lucide-react';
import { useAuth, useMe } from '@/lib/auth';
import { hasMainWindow, notifyOpener, openInMainWindow, StandaloneTicketContext } from '@/lib/open-ticket';
import { useTheme } from '@/hooks/use-theme';
import { logoUrl } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { TimerWidget } from '@/components/layout/timer-widget';
import TicketDetailPage, { ticketQuery } from './detail';

const TICKET_PATH = /^\/tickets\/(\d+)$/;

/**
 * A ticket in its own browser window (like Autotask): a slim top bar and the
 * ticket page, without the sidebar. Links to other pages open in the main
 * window; links to other tickets stay in this window.
 */
export default function TicketWindowPage() {
  const id = Number(useParams().id);
  const me = useMe();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useTheme(); // applies the user's light/dark choice to this window
  const ticket = useQuery(ticketQuery(id));
  const orgLogo = logoUrl('organization', 0, me.organization.logoUpdatedAt);

  // Changes made here refresh the lists in the main window.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return qc.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.mutation.state.status !== 'success') return;
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => notifyOpener({ type: 'taskora:ticket-changed', ticketId: id }), 300);
    });
  }, [qc, id]);

  /** Routes clicks on in-app links: tickets stay here, everything else goes to the main window. */
  const routeLinks = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    const path = url.pathname + url.search + url.hash;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/t/')) return;
    e.preventDefault();
    const m = TICKET_PATH.exec(url.pathname);
    if (m) navigate(`/t/${m[1]}`);
    else openInMainWindow(path);
  };

  const openInMain = () => {
    if (hasMainWindow()) {
      openInMainWindow(`/tickets/${id}`);
      window.close();
    } else window.location.assign(`/tickets/${id}`);
  };

  return (
    <StandaloneTicketContext.Provider value={true}>
      <div className="flex h-dvh flex-col overflow-hidden" onClickCapture={routeLinks}>
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-3">
          <div className="flex min-w-0 items-center gap-2">
            {orgLogo ? <img src={orgLogo} alt="" className="size-6 rounded bg-white object-contain p-0.5" /> : <img src="/favicon.svg" alt="" className="size-5" />}
            <span className="hidden truncate text-[13px] font-semibold tracking-tight sm:inline">{orgLogo ? me.organization.name : 'Taskora'}</span>
          </div>
          <span className="text-subtle">/</span>
          <span className="truncate font-mono text-[13px] font-medium">{ticket.data?.ticketNumber ?? '…'}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {can('time.write') && <TimerWidget />}
            <Button size="sm" variant="ghost" onClick={openInMain} title="Show this ticket in the main Taskora window">
              <AppWindow /> Open in main window
            </Button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <TicketDetailPage key={id} standalone />
        </main>
      </div>
    </StandaloneTicketContext.Provider>
  );
}

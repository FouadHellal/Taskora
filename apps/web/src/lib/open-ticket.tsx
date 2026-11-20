/**
 * Opening tickets the Autotask way: each ticket in its own browser window
 * (/t/:id, without the application shell) unless the user prefers the main
 * window. Ctrl/Cmd/Shift/middle click keep the browser's own behaviour, phones
 * always stay in the same window, and a blocked popup falls back to a normal
 * navigation.
 */
import { createContext, useCallback, useContext, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNarrow } from '@/hooks/use-media-query';
import { useAuth, type Me } from './auth';

export type TicketOpenMode = 'window' | 'same';

/** True inside the standalone ticket window. */
export const StandaloneTicketContext = createContext(false);
export const useStandaloneTicket = () => useContext(StandaloneTicketContext);

/** The user's choice (`preferences.ticketOpenMode`), else the organization default. */
export function ticketOpenMode(me: Me | null | undefined): TicketOpenMode {
  const pref = me?.preferences?.ticketOpenMode;
  if (pref === 'window' || pref === 'same') return pref;
  return me?.organization.ticketsOpenInWindow === false ? 'same' : 'window';
}

export const ticketWindowName = (id: number) => `taskora-ticket-${id}`;

/**
 * Opens the ticket's own window, or focuses it when it is already open (its
 * unsaved edits are kept). Returns false when the browser blocked the popup.
 */
export function openTicketWindow(id: number): boolean {
  const url = `/t/${id}`;
  let w: Window | null = null;
  try {
    // An empty URL returns the existing named window without reloading it.
    w = window.open('', ticketWindowName(id), 'popup,width=1280,height=900');
  } catch {
    w = null;
  }
  if (!w) return false;
  try {
    if (w.location.pathname !== url) w.location.href = url;
  } catch {
    w.location.href = url;
  }
  try {
    w.focus();
  } catch {
    /* ignore */
  }
  return true;
}

type ClickLike = Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'button'>;

const withModifier = (e?: ClickLike | null) => !!e && (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button === 1);

/** `openTicket(id, event?)` for row clicks, menus and links. */
export function useOpenTicket() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const narrow = useNarrow();
  const standalone = useStandaloneTicket();
  return useCallback(
    (id: number, e?: ClickLike | null) => {
      if (withModifier(e)) {
        window.open(`/tickets/${id}`, '_blank');
        return;
      }
      // Inside a ticket window, other tickets open in that same window.
      if (standalone) return navigate(`/t/${id}`);
      if (!narrow && ticketOpenMode(me) === 'window' && openTicketWindow(id)) return;
      navigate(`/tickets/${id}`);
    },
    [navigate, me, narrow, standalone],
  );
}

const TICKET_PATH = /^\/tickets\/(\d+)$/;

/** Navigates to an app link, opening ticket links with `useOpenTicket`. */
export function useOpenLink() {
  const navigate = useNavigate();
  const openTicket = useOpenTicket();
  return useCallback(
    (to: string, e?: ClickLike | null) => {
      const m = TICKET_PATH.exec(to);
      if (m) openTicket(Number(m[1]), e);
      else navigate(to);
    },
    [navigate, openTicket],
  );
}

/** A link to a ticket that honours the open-in-window preference. */
export function TicketLink({ ticketId, onClick, children, ...rest }: { ticketId: number } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const openTicket = useOpenTicket();
  return (
    <a
      href={`/tickets/${ticketId}`}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || withModifier(e) || e.button !== 0) return;
        e.preventDefault();
        openTicket(ticketId);
      }}
    >
      {children}
    </a>
  );
}

/* ------------------------------------------------- window <-> main window */

export type WindowMessage = { type: 'taskora:navigate'; to: string } | { type: 'taskora:ticket-changed'; ticketId: number };

/** The window that opened this one, when it is a Taskora window of the same origin. */
function sameOriginOpener(): Window | null {
  try {
    const o = window.opener as Window | null;
    if (o && !o.closed && o.location.origin === window.location.origin) return o;
  } catch {
    /* cross-origin or gone */
  }
  return null;
}

export function notifyOpener(msg: WindowMessage): boolean {
  const o = sameOriginOpener();
  if (!o) return false;
  o.postMessage(msg, window.location.origin);
  return true;
}

/** Shows an app page in the main window (focusing it); without one, in a new tab. */
export function openInMainWindow(to: string) {
  const o = sameOriginOpener();
  if (o) {
    o.postMessage({ type: 'taskora:navigate', to } satisfies WindowMessage, window.location.origin);
    try {
      o.focus();
    } catch {
      /* the browser may refuse to raise another window */
    }
    return;
  }
  window.open(to, '_blank');
}

export const hasMainWindow = () => !!sameOriginOpener();

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { WindowMessage } from '@/lib/open-ticket';

/** Same-origin app path only: no protocol-relative or backslash tricks. */
const isAppPath = (to: unknown): to is string => typeof to === 'string' && to.length < 2000 && to.startsWith('/') && !/^\/[/\\]/.test(to);

/**
 * The main window listens to its ticket windows: links to other pages
 * (company, contact, device…) open here, and changes made in a ticket window
 * refresh the lists shown here.
 */
export function useOpenerNavigation() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const msg = e.data as Partial<WindowMessage> | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'taskora:navigate' && isAppPath((msg as { to?: unknown }).to)) {
        navigate((msg as { to: string }).to);
        window.focus();
      } else if (msg.type === 'taskora:ticket-changed') {
        qc.invalidateQueries({ predicate: (q) => !['me', 'lookups'].includes(String(q.queryKey[0])) });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate, qc]);
}

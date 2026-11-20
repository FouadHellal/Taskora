import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '../ui/overlays';
import { Kbd } from '../ui/misc';
import { translate as t } from '@/lib/i18n';

const SHORTCUTS: [string, string][] = [
  ['Ctrl / ⌘ + K', 'Search everything'],
  ['/', 'Search everything'],
  ['N', 'New ticket'],
  ['G then D', 'Go to dashboard'],
  ['G then T', 'Go to all tickets'],
  ['G then M', 'Go to my tickets'],
  ['G then C', 'Go to companies'],
  ['G then A', 'Go to configuration items'],
  ['G then W', 'Go to my work'],
  ['?', 'Show this help'],
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function useGlobalShortcuts({ openPalette, openHelp }: { openPalette: () => void; openHelp: () => void }) {
  const navigate = useNavigate();
  const pendingG = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
        return;
      }
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      const key = e.key.toLowerCase();
      if (Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        const target = { d: '/', t: '/tickets', m: '/tickets/mine', c: '/companies', a: '/assets', w: '/my-work' }[key];
        if (target) {
          e.preventDefault();
          navigate(target);
        }
        return;
      }
      if (key === 'g') pendingG.current = Date.now();
      else if (key === '/') {
        e.preventDefault();
        openPalette();
      } else if (key === 'n') {
        e.preventDefault();
        navigate('/tickets/new');
      } else if (e.key === '?') {
        e.preventDefault();
        openHelp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, openPalette, openHelp]);
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" size="sm">
      <dl className="divide-y divide-border">
        {SHORTCUTS.map(([k, label]) => (
          <div key={label + k} className="flex items-center justify-between py-1.5 text-[13px]">
            <dt className="text-muted">{t(label)}</dt>
            <dd>
              <Kbd>{k}</Kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

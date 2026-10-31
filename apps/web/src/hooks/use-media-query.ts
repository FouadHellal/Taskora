import { useEffect, useState } from 'react';

function matches(query: string) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** Tracks a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const update = () => setValue(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return value;
}

/** Phone layout: lists become cards (below Tailwind's `sm`, 640 px). */
export const usePhone = () => useMediaQuery('(max-width: 639px)');

/** Small screens: the sidebar becomes a slide-in menu (below `md`, 768 px). */
export const useNarrow = () => useMediaQuery('(max-width: 767px)');

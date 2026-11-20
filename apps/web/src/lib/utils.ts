import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNowStrict, isValid, parseISO, setDefaultOptions, type Locale } from 'date-fns';
import { de, es, fr, nl } from 'date-fns/locale';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = typeof v === 'string' ? (v.length === 10 ? parseISO(v) : new Date(v)) : v;
  return isValid(d) ? d : null;
}

/* ------------------------------------------------------- date settings */

/** Organization date format; 'auto' = "20 Nov 2026" in the UI language. */
export type DateFormat = 'auto' | 'dd/MM/yyyy' | 'MM/dd/yyyy' | 'yyyy-MM-dd' | 'dd.MM.yyyy';

const LOCALES: Record<string, Locale | undefined> = { fr, nl, de, es };
const PATTERNS: DateFormat[] = ['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy'];

let dateLocale: Locale | undefined;
let datePattern = 'dd MMM yyyy';

/**
 * Sets the language and organization date format used by the helpers below
 * (and by date-fns' own format() calls). Called by the i18n provider; plain
 * module state so non-React code formats the same way.
 */
export function setDateConfig({ locale, dateFormat }: { locale?: string; dateFormat?: DateFormat | string | null }) {
  dateLocale = locale ? LOCALES[locale] : undefined;
  datePattern = dateFormat && (PATTERNS as string[]).includes(dateFormat) ? dateFormat : 'dd MMM yyyy';
  // English keeps date-fns' built-in en-US locale.
  setDefaultOptions({ locale: dateLocale });
}

export function fmtDate(v: string | Date | null | undefined, fallback = '—') {
  const d = toDate(v);
  return d ? format(d, datePattern, { locale: dateLocale }) : fallback;
}

export function fmtDateTime(v: string | Date | null | undefined, fallback = '—') {
  const d = toDate(v);
  return d ? format(d, `${datePattern} HH:mm`, { locale: dateLocale }) : fallback;
}

export function fmtTime(v: string | Date | null | undefined) {
  const d = toDate(v);
  return d ? format(d, 'HH:mm') : '';
}

export function fmtRelative(v: string | Date | null | undefined, fallback = '—') {
  const d = toDate(v);
  if (!d) return fallback;
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: dateLocale });
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(v: string | Date | null | undefined) {
  const d = toDate(v);
  return d ? format(d, "yyyy-MM-dd'T'HH:mm") : '';
}

export function todayIso() {
  return format(new Date(), 'yyyy-MM-dd');
}

export function initials(name: string | null | undefined) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function fullName(p: { firstName?: string | null; lastName?: string | null } | null | undefined) {
  return p ? [p.firstName, p.lastName].filter(Boolean).join(' ') : '';
}

export function hours(minutes: number | null | undefined) {
  return ((minutes ?? 0) / 60).toFixed(2);
}

export function pluralize(n: number, word: string, plural = `${word}s`) {
  return `${n} ${n === 1 ? word : plural}`;
}

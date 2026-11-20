import { Children, createContext, Fragment, isValidElement, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useAuth } from './auth';
import { setDateConfig, type DateFormat } from './utils';

/**
 * Lightweight UI translation.
 *
 * Dictionaries are keyed by the exact English source string: English needs no
 * dictionary, and a string missing from a dictionary falls back to English.
 * `{name}` placeholders are filled from the `vars` argument.
 *
 * Most screens never call `t()` themselves: the shared components (page
 * header, cards, tabs, dialogs, forms, tables, buttons…) translate the plain
 * strings they receive.
 */

export type Lang = 'en' | 'fr' | 'nl' | 'de' | 'es';
export type Dict = Record<string, string>;
export type Vars = Record<string, string | number | null | undefined>;

/** Supported languages, each labelled in its own language (for pickers). */
export const LANGUAGES: { code: Lang; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
];

export const DATE_FORMATS: DateFormat[] = ['auto', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy'];

const CODES = LANGUAGES.map((l) => l.code);
export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (CODES as string[]).includes(v);

const loaders: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Dict }>> = {
  fr: () => import('../i18n/fr'),
  nl: () => import('../i18n/nl'),
  de: () => import('../i18n/de'),
  es: () => import('../i18n/es'),
};

const cache: Partial<Record<Lang, Dict>> = { en: {} };
let current: Lang = 'en';
let dict: Dict = {};

/** Loads (once) the dictionary of a language. */
export async function loadLanguage(lang: Lang): Promise<Dict> {
  const hit = cache[lang];
  if (hit) return hit;
  const mod = await loaders[lang as Exclude<Lang, 'en'>]();
  cache[lang] = mod.default;
  return mod.default;
}

/** Makes `lang` the active language (its dictionary must be loaded or given). */
export function setLanguage(lang: Lang, dictionary?: Dict) {
  if (dictionary) cache[lang] = dictionary;
  current = lang;
  dict = cache[lang] ?? {};
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export function getLanguage(): Lang {
  return current;
}

function interpolate(s: string, vars?: Vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

/** Translates outside React (toasts, helpers). Unknown strings stay English. */
export function translate(text: string, vars?: Vars): string {
  return interpolate(dict[text] ?? text, vars);
}

/** Whether a translation exists for `text` in the active language. */
export function hasTranslation(text: string) {
  return current === 'en' || text in dict;
}

/**
 * Translates the plain-string parts of a React node (keeps the surrounding
 * whitespace, leaves elements such as icons alone). Used by shared components
 * for their children/props, e.g. `<Button><Plus /> New ticket</Button>`.
 */
export function translateNode(node: ReactNode): ReactNode {
  if (typeof node === 'string') return translateText(node);
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'number') return node;
  if (Array.isArray(node)) {
    if (!node.some((c) => typeof c === 'string')) return node;
    // Children.map keeps keys stable for element children.
    return Children.map(node, (c) => (typeof c === 'string' ? translateText(c) : c));
  }
  if (isValidElement(node) && node.type === Fragment) {
    const props = (node as ReactElement<{ children?: ReactNode }>).props;
    return <Fragment key={node.key}>{translateNode(props.children)}</Fragment>;
  }
  return node;
}

function translateText(s: string) {
  if (current === 'en') return s;
  const core = s.trim();
  if (!core) return s;
  const hit = dict[core];
  if (hit === undefined) return s;
  return s.slice(0, s.indexOf(core)) + hit + s.slice(s.indexOf(core) + core.length);
}

/* ------------------------------------------------------------------ React */

interface I18nState {
  lang: Lang;
  t: (text: string, vars?: Vars) => string;
}

const I18nContext = createContext<I18nState>({ lang: 'en', t: translate });

function browserLanguage(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  for (const l of navigator.languages ?? [navigator.language]) {
    const code = l?.slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return 'en';
}

/**
 * Picks the language (user preference, else organization default, else the
 * browser language while signed out), loads its dictionary and applies the
 * organization's date format. Changing either remounts the tree below so every
 * screen re-renders with the new texts and dates.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const prefLang = me?.preferences?.language;
  const wanted: Lang = me ? (isLang(prefLang) ? prefLang : isLang(me.organization.language) ? me.organization.language : 'en') : browserLanguage();
  const dateFormat: DateFormat = me?.organization.dateFormat ?? 'auto';

  const [active, setActive] = useState<Lang | null>(() => (cache[wanted] ? wanted : null));

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    loadLanguage(wanted)
      .catch(() => cache.en!)
      .then((d) => {
        if (cancelled) return;
        const lang = d === cache.en ? 'en' : wanted;
        setLanguage(lang);
        setActive(lang);
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, loading]);

  // Module-level state used by translate() and the date helpers is updated
  // during render so the first paint already uses it.
  if (active) {
    if (current !== active) setLanguage(active);
    setDateConfig({ locale: active, dateFormat });
  }

  const value = useMemo<I18nState>(() => ({ lang: active ?? 'en', t: translate }), [active]);

  // Wait for the first dictionary so the UI does not flash in English.
  if (!active) return null;
  return (
    <I18nContext.Provider value={value}>
      <Fragment key={`${active}|${dateFormat}`}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

/** `const t = useT(); t('Save')`, `t('Sign in to {name}', { name })`. */
export function useT() {
  return useContext(I18nContext).t;
}

export function useLanguage() {
  return useContext(I18nContext).lang;
}

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { getLanguage, isLang, LANGUAGES, setLanguage, translate, translateNode } from '../i18n';
import { fmtDate, fmtDateTime, fmtRelative, setDateConfig } from '../utils';

afterEach(() => {
  setLanguage('en');
  setDateConfig({ locale: 'en', dateFormat: 'auto' });
});

describe('translate', () => {
  it('returns English unchanged and interpolates variables', () => {
    expect(translate('Save')).toBe('Save');
    expect(translate('Sign in to {name}', { name: 'Acme' })).toBe('Sign in to Acme');
    // Unknown variables stay visible rather than disappearing.
    expect(translate('Hello {who}')).toBe('Hello {who}');
  });

  it('uses the active dictionary and falls back to English for missing keys', () => {
    setLanguage('fr', { Save: 'Enregistrer', 'Sign in to {name}': 'Se connecter à {name}' });
    expect(getLanguage()).toBe('fr');
    expect(translate('Save')).toBe('Enregistrer');
    expect(translate('Sign in to {name}', { name: 'Acme' })).toBe('Se connecter à Acme');
    expect(translate('Not in the dictionary')).toBe('Not in the dictionary');
  });

  it('translates only the string parts of a node and keeps whitespace', () => {
    setLanguage('de', { 'New ticket': 'Neues Ticket' });
    const icon = createElement('svg', { key: 'i' });
    const out = translateNode([icon, ' New ticket']) as unknown[];
    expect(out[1]).toBe(' Neues Ticket');
    expect(translateNode('Unknown')).toBe('Unknown');
    expect(translateNode(42)).toBe(42);
  });

  it('ships a complete dictionary per language', async () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'fr', 'nl', 'de', 'es']);
    expect(isLang('nl')).toBe(true);
    expect(isLang('it')).toBe(false);
    for (const { code } of LANGUAGES.filter((l) => l.code !== 'en')) {
      const dict = (await import(`../../i18n/${code}.ts`)).default as Record<string, string>;
      expect(dict.Save).toBeTruthy();
      // Translations keep the placeholders of their English key.
      for (const [k, v] of Object.entries(dict)) {
        const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
        expect(vars(v), `${code}: ${k}`).toBe(vars(k));
      }
    }
  });
});

describe('date settings', () => {
  const d = new Date(2026, 10, 5, 14, 30);

  it('formats in English by default', () => {
    expect(fmtDate(d)).toBe('05 Nov 2026');
    expect(fmtDateTime(d)).toBe('05 Nov 2026 14:30');
    expect(fmtDate(null)).toBe('—');
  });

  it('uses the language locale when the format is auto', () => {
    setDateConfig({ locale: 'fr', dateFormat: 'auto' });
    expect(fmtDate(d)).toBe('05 nov. 2026');
    setDateConfig({ locale: 'de', dateFormat: 'auto' });
    expect(fmtDate(d)).toBe('05 Nov. 2026');
    expect(fmtRelative(new Date(Date.now() - 3 * 86_400_000))).toBe('vor 3 Tagen');
  });

  it('honours an explicit organization date format', () => {
    setDateConfig({ locale: 'nl', dateFormat: 'dd/MM/yyyy' });
    expect(fmtDate(d)).toBe('05/11/2026');
    setDateConfig({ locale: 'en', dateFormat: 'MM/dd/yyyy' });
    expect(fmtDateTime(d)).toBe('11/05/2026 14:30');
    setDateConfig({ locale: 'es', dateFormat: 'yyyy-MM-dd' });
    expect(fmtDate('2026-11-05')).toBe('2026-11-05');
    setDateConfig({ locale: 'de', dateFormat: 'dd.MM.yyyy' });
    expect(fmtDate(d)).toBe('05.11.2026');
    // Unknown values fall back to the automatic format.
    setDateConfig({ locale: 'en', dateFormat: 'bogus' });
    expect(fmtDate(d)).toBe('05 Nov 2026');
  });
});

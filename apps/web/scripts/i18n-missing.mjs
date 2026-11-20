#!/usr/bin/env node
/**
 * Lists the English UI strings that reach the translating shared components
 * (page headers, cards, tabs, dialogs, form fields, table headers, buttons…)
 * and reports which ones are missing from each dictionary in src/i18n.
 *
 *   node apps/web/scripts/i18n-missing.mjs            summary per language
 *   node apps/web/scripts/i18n-missing.mjs fr         missing strings for fr
 *   node apps/web/scripts/i18n-missing.mjs --all      every collected string (with a file)
 *   node apps/web/scripts/i18n-missing.mjs --unused   dictionary keys no longer found
 *   node apps/web/scripts/i18n-missing.mjs --json fr  missing strings for fr as JSON
 *
 * Exit code is 0; the script is a helper, not a gate.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const LANGS = ['fr', 'nl', 'de', 'es'];

/** Components whose listed props are translated. */
const PROP_TRANSLATED = {
  PageHeader: ['title', 'subtitle'],
  CardHeader: ['title', 'description'],
  Dialog: ['title', 'description'],
  ConfirmDialog: ['title', 'description', 'confirmLabel'],
  EmptyState: ['title', 'description'],
  FormField: ['label', 'hint'],
  FormSection: ['title'],
  Field: ['label'],
  Stat: ['label', 'hint'],
  Checkbox: ['label'],
  Select: ['placeholder'],
  Input: ['placeholder'],
  Textarea: ['placeholder'],
  SearchInput: ['placeholder'],
  FilterSelect: ['placeholder'],
  Tooltip: ['content'],
  AuthCard: ['title', 'subtitle'],
};
/** Components whose plain-string children are translated. */
const CHILD_TRANSLATED = new Set(['Button', 'TabsTrigger', 'DropdownItem', 'DropdownLabel', 'Label', 'CardHeader']);
/** Functions whose first string argument is a source string. */
const CALLS = new Set(['t', 'translate']);
/** Object properties holding source strings anywhere (table column headers). */
const PROPS_ANYWHERE = new Set(['header']);
/** Files where every `label: '…'` is a source string (navigation, badges…). */
const LABEL_FILES = ['components/layout/nav.ts', 'components/badges.tsx', 'components/layout/command-palette.tsx'];

/** Strings used dynamically by the shared components (not visible to the scan). */
const EXTRA = [
  // shortcuts dialog
  'Search everything', 'New ticket', 'Go to dashboard', 'Go to all tickets', 'Go to my tickets', 'Go to companies',
  'Go to configuration items', 'Go to my work', 'Show this help',
  // dialogs / form / login / setup
  'Confirm', 'Validation failed', 'Invalid email or password', 'Passwords do not match', 'Setup token', 'Organization name',
  // common words for screens that call t() directly (settings, pickers…)
  'Language', 'Date format', 'Organization default', 'Use the organization default', 'Automatic', 'Automatic (language default)',
  'Preferences', 'My preferences', 'Personal settings', 'Organization settings', 'Appearance', 'Theme', 'Account', 'Security',
  'Saved', 'Settings saved', 'Saving…', 'Continue', 'Optional', 'None', 'Unknown', 'No', 'OK', 'Apply', 'Copy', 'Copied',
  'Today', 'Yesterday', 'Tomorrow', 'Week', 'Month', 'Year', 'Day', 'Days', 'Hours', 'Minutes',
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'i18n') walk(p, out);
    } else if (/\.(tsx?|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const tagName = (n) => (ts.isIdentifier(n) ? n.text : ts.isPropertyAccessExpression(n) ? n.name.text : '');

/** String literals an expression can evaluate to (conditionals, ?? and || fallbacks). */
function literals(e) {
  if (!e) return [];
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isParenthesizedExpression(e)) return literals(e.expression);
  if (ts.isConditionalExpression(e)) return [...literals(e.whenTrue), ...literals(e.whenFalse)];
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind))
    return [...literals(e.left), ...literals(e.right)];
  if (ts.isJsxExpression(e)) return literals(e.expression);
  return [];
}

const found = new Map(); // text -> first file
function add(text, file) {
  const s = text.replace(/\s+/g, ' ').trim();
  // Skip empty strings, symbols and sample e-mail addresses / URLs.
  if (!s || !/[A-Za-z]/.test(s) || /^\S+@\S+$/.test(s) || /^https?:\/\//.test(s)) return;
  if (!found.has(s)) found.set(s, file);
}

function scan(file) {
  const rel = relative(src, file).replaceAll('\\', '/');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const labelFile = LABEL_FILES.includes(rel);
  const visit = (n) => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const props = PROP_TRANSLATED[tagName(n.tagName)];
      for (const a of n.attributes.properties) {
        if (!ts.isJsxAttribute(a) || !a.initializer) continue;
        const name = a.name.getText(sf);
        if (props?.includes(name)) for (const s of literals(a.initializer)) add(s, rel);
        // breadcrumbs={[{ label: 'Companies', to: … }]}
        if (name === 'breadcrumbs')
          a.initializer.forEachChild(function crumbs(c) {
            if (ts.isPropertyAssignment(c) && c.name.getText(sf) === 'label') for (const s of literals(c.initializer)) add(s, rel);
            c.forEachChild(crumbs);
          });
      }
    }
    if (ts.isJsxElement(n) && CHILD_TRANSLATED.has(tagName(n.openingElement.tagName))) {
      for (const c of n.children) {
        if (ts.isJsxText(c)) add(c.text, rel);
        else if (ts.isJsxExpression(c)) for (const s of literals(c.expression)) add(s, rel);
      }
    }
    if (ts.isCallExpression(n) && CALLS.has(tagName(n.expression)) && n.arguments[0]) for (const s of literals(n.arguments[0])) add(s, rel);
    if (ts.isPropertyAssignment(n)) {
      const key = n.name.getText(sf);
      if (PROPS_ANYWHERE.has(key) || (labelFile && key === 'label')) for (const s of literals(n.initializer)) add(s, rel);
    }
    n.forEachChild(visit);
  };
  visit(sf);
}

for (const f of walk(src)) scan(f);
for (const s of EXTRA) add(s, '(extra)');

function readDict(lang) {
  const file = join(src, 'i18n', `${lang}.ts`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return new Map();
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dict = new Map();
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name)) && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)))
      dict.set(n.name.text, n.initializer.text);
    n.forEachChild(visit);
  };
  visit(sf);
  return dict;
}

const args = process.argv.slice(2);
const strings = [...found.keys()].sort((a, b) => a.localeCompare(b));

if (args[0] === '--all') {
  for (const s of strings) console.log(`${JSON.stringify(s)}\t${found.get(s)}`);
  console.log(`\n${strings.length} strings`);
} else if (args[0] === '--unused') {
  for (const l of LANGS) {
    const unused = [...readDict(l).keys()].filter((k) => !found.has(k));
    console.log(`${l}: ${unused.length} keys not found by the scan (may still be used dynamically)`);
    for (const k of unused) console.log(`  ${JSON.stringify(k)}`);
  }
} else if (args[0] === '--json' || LANGS.includes(args[0])) {
  const lang = args[0] === '--json' ? args[1] : args[0];
  const dict = readDict(lang);
  const missing = strings.filter((s) => !dict.has(s));
  if (args[0] === '--json') console.log(JSON.stringify(Object.fromEntries(missing.map((s) => [s, ''])), null, 2));
  else {
    for (const s of missing) console.log(`${JSON.stringify(s)}\t${found.get(s)}`);
    console.log(`\n${lang}: ${missing.length} of ${strings.length} missing`);
  }
} else {
  console.log(`${strings.length} source strings found`);
  for (const l of LANGS) {
    const dict = readDict(l);
    const missing = strings.filter((s) => !dict.has(s)).length;
    console.log(`${l}: ${dict.size} entries, ${missing} missing`);
    // A translation must keep the same {placeholders} as its English key.
    const vars = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const [k, v] of dict) if (vars(k) !== vars(v)) console.log(`  placeholder mismatch: ${JSON.stringify(k)} -> ${JSON.stringify(v)}`);
  }
}

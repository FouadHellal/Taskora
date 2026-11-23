/**
 * The HTML layout every Taskora e-mail uses (ticket e-mails, client
 * notifications, IT alerts, invitations, test e-mail): branded header with the
 * e-mail logo, accent colour, a ticket card, an optional quote, statistics,
 * a button, the organization's HTML signature and a footer. Table-based with
 * inline styles so it renders the same in Outlook, Gmail and phones.
 */
import { and, eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Tx } from '../db/client.js';
import { logos } from '../db/schema/index.js';
import { getSystemSettings, type SystemSettings } from './settings.js';
import type { SmtpSettings } from './mail.js';

export function escapeHtml(v: string) {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const paragraphHtml = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

/* ---------------------------------------------------------------- signature */

export const isHtml = (v: string) => /<\s*[a-z][\s\S]*>/i.test(v);

/** Removes scripts, frames, forms, event handlers and javascript: links from an HTML signature. */
export function sanitizeEmailHtml(html: string) {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|textarea|select|button|meta|link|base|svg)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/<\s*(script|iframe|object|embed|meta|link|base|input)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript|data:text)[^"']*\2/gi, '$1="#"');
}

/** Plain-text version of an HTML fragment. */
export function htmlToText(html: string) {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|h[1-6]|li|table)\s*>/gi, '\n')
    .replace(/<\s*\/\s*td\s*>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SignatureVars {
  /** Who sends: the technician for ticket e-mails, otherwise the organization. */
  sender: string;
  organization: string;
  /** Public URL of the e-mail logo (or the organization logo). */
  logo: string;
  portal: string;
}

/** The signature as HTML and text. HTML signatures may use {{logo}}, {{sender}}, {{organization}} and {{portal}}. */
export function renderSignature(signature: string, vars: SignatureVars): { html: string; text: string } | null {
  const raw = signature.trim();
  if (!raw) return null;
  const fill = (v: string, esc: boolean) =>
    v.replace(/\{\{\s*(logo|sender|organization|portal)\s*\}\}/g, (_, k: keyof SignatureVars) => (esc ? escapeHtml(vars[k]) : vars[k]));
  if (isHtml(raw)) {
    const html = sanitizeEmailHtml(fill(raw, true));
    return { html, text: htmlToText(html) };
  }
  const text = fill(raw, false);
  return { html: `<div style="font-size:14px;line-height:1.6;color:#334155">${paragraphHtml(text)}</div>`, text };
}

/* -------------------------------------------------------------------- brand */

export interface MailBrand {
  orgName: string;
  headerColor: string;
  accentColor: string;
  /** Inline (cid) logo for the header. */
  logo: { cid: string; content: Buffer; contentType: string } | null;
  /** Public address of the logo, for HTML signatures ({{logo}}). */
  logoUrl: string;
  base: string;
  signature: string;
  footerNote: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Brand of the e-mails: colours from System settings, the e-mail logo (else the organization logo) and the SMTP signature. */
export async function loadMailBrand(db: Tx, config: Config, smtp: Pick<SmtpSettings, 'signature'> | null, settings?: SystemSettings): Promise<MailBrand> {
  const s = settings ?? (await getSystemSettings(db));
  const rows = await db.select().from(logos).where(and(eq(logos.entityId, 0)));
  const emailLogo = rows.find((r) => r.entityType === 'email') ?? rows.find((r) => r.entityType === 'organization') ?? null;
  const base = (config.PUBLIC_URL ?? '').replace(/\/$/, '');
  return {
    orgName: s.organizationName,
    headerColor: HEX.test(s.emailHeaderColor) ? s.emailHeaderColor : '#ffffff',
    accentColor: HEX.test(s.emailAccentColor) ? s.emailAccentColor : '#2563eb',
    logo: emailLogo ? { cid: 'brand-logo@taskora', content: Buffer.from(emailLogo.data, 'base64'), contentType: emailLogo.mimeType } : null,
    logoUrl: base ? `${base}/api/v1/logos/${rows.some((r) => r.entityType === 'email') ? 'email' : 'organization'}` : '',
    base,
    signature: smtp?.signature ?? '',
    footerNote: s.emailFooter,
  };
}

/** Black or white text, whichever reads better on the colour. */
function textOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#0f172a' : '#ffffff';
}

/* ------------------------------------------------------------------- layout */

export interface EmailContent {
  /** Hidden preview line shown by mail clients. */
  preheader: string;
  /** Small coloured line above the heading ("Request received"). */
  eyebrow?: string;
  heading?: string;
  greeting?: string;
  paragraphs: string[];
  /** Ticket card: reference, title, status and facts. */
  card?: { ref?: string; title?: string; status?: { label: string; color?: string | null } | null; facts: [string, string][] };
  facts?: [string, string][];
  quote?: { label: string; text: string };
  stats?: [string, string][];
  button?: { label: string; url: string } | null;
  hint?: string;
  footer: string;
  /** Override the accent (e.g. green for "resolved"). */
  accent?: string;
  /** Append the organization signature (client-facing e-mails). */
  signature?: { sender: string } | false;
}

export function renderEmail(brand: MailBrand, c: EmailContent): { html: string; text: string } {
  const accent = c.accent ?? brand.accentColor;
  const headerText = textOn(brand.headerColor);
  const font = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const sig = c.signature
    ? renderSignature(brand.signature, { sender: c.signature.sender, organization: brand.orgName, logo: brand.logoUrl, portal: brand.base ? `${brand.base}/portal` : '' })
    : null;

  const head = brand.logo
    ? `<img src="cid:${brand.logo.cid}" alt="${escapeHtml(brand.orgName)}" height="54" style="display:block;height:54px;max-width:260px;border:0;outline:none">`
    : `<span style="font-size:20px;font-weight:700;color:${headerText};letter-spacing:.02em">${escapeHtml(brand.orgName)}</span>`;
  const refPill = c.card?.ref
    ? `<span style="display:inline-block;padding:6px 12px;border-radius:999px;border:1px solid ${headerText === '#ffffff' ? 'rgba(255,255,255,.35)' : '#cbd5e1'};color:${headerText};font-size:12px;font-weight:600;font-family:Consolas,Menlo,monospace">${escapeHtml(c.card.ref)}</span>`
    : '';

  const factRows = (rows: [string, string][]) =>
    rows
      .map(
        ([k, v], i) =>
          `<tr><td style="padding:9px 0;${i ? 'border-top:1px solid #e8ebf2;' : ''}font-size:13px;color:#64748b;width:40%;vertical-align:top">${escapeHtml(k)}</td><td style="padding:9px 0;${i ? 'border-top:1px solid #e8ebf2;' : ''}font-size:14px;color:#0f172a;font-weight:600;vertical-align:top">${escapeHtml(v)}</td></tr>`,
      )
      .join('');

  const card = c.card
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate">
<tr><td style="padding:16px 18px 6px">
${c.card.title ? `<div style="font-size:16px;font-weight:700;color:#0f172a;line-height:1.35">${escapeHtml(c.card.title)}</div>` : ''}
${
  c.card.status
    ? `<div style="margin-top:8px"><span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:${c.card.status.color ?? accent};background:${(c.card.status.color ?? accent) + '1a'}">${escapeHtml(c.card.status.label)}</span></div>`
    : ''
}
</td></tr>
<tr><td style="padding:6px 18px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${factRows(c.card.facts)}</table></td></tr>
</table>`
    : '';
  const facts = c.facts?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0">${factRows(c.facts)}</table>`
    : '';
  const stats = c.stats?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:18px -6px">${'<tr>'}${c.stats
        .map(
          ([k, v]) =>
            `<td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 8px;text-align:center"><div style="font-size:22px;font-weight:700;color:${accent}">${escapeHtml(v)}</div><div style="font-size:12px;color:#64748b;margin-top:4px">${escapeHtml(k)}</div></td>`,
        )
        .join('')}</tr></table>`
    : '';
  const quote = c.quote?.text.trim()
    ? `<div style="margin:22px 0"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:8px">${escapeHtml(c.quote.label)}</div><div style="border-left:3px solid ${accent};background:#f8fafc;border-radius:0 8px 8px 0;padding:14px 16px;font-size:14px;line-height:1.6;color:#334155">${paragraphHtml(c.quote.text.trim().slice(0, 6000))}</div></div>`
    : '';
  const button = c.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px"><tr><td style="background:${accent};border-radius:8px"><a href="${escapeHtml(c.button.url)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:${textOn(accent)};text-decoration:none;font-family:${font}">${escapeHtml(c.button.label)} &rarr;</a></td></tr></table>`
    : '';
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#334155">${paragraphHtml(t)}</p>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(c.heading ?? c.preheader)}</title></head>
<body style="margin:0;padding:0;background:#eef1f6;font-family:${font}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="background:${brand.headerColor};padding:22px 30px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle">${head}</td><td align="right" style="vertical-align:middle">${refPill}</td></tr></table></td></tr>
<tr><td style="height:4px;line-height:4px;font-size:0;background:${accent}">&nbsp;</td></tr>
<tr><td style="padding:30px 30px 10px">
${c.eyebrow ? `<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${accent};margin-bottom:8px">${escapeHtml(c.eyebrow)}</div>` : ''}
${c.heading ? `<h1 style="margin:0 0 18px;font-size:23px;line-height:1.3;color:#0f172a;font-weight:700">${escapeHtml(c.heading)}</h1>` : ''}
${c.greeting ? p(c.greeting) : ''}
${c.paragraphs.map(p).join('')}
${card}${stats}${facts}${quote}${button}
${c.hint ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.55;color:#64748b">${paragraphHtml(c.hint)}</p>` : ''}
</td></tr>
${sig ? `<tr><td style="padding:10px 30px 26px"><div style="border-top:1px solid #e8ebf2;padding-top:20px">${sig.html}</div></td></tr>` : '<tr><td style="height:16px"></td></tr>'}
<tr><td style="padding:16px 30px;background:#f8fafc;border-top:1px solid #e8ebf2;font-size:12px;line-height:1.55;color:#94a3b8">${paragraphHtml(c.footer)}${brand.footerNote.trim() ? `<br>${paragraphHtml(brand.footerNote.trim())}` : ''}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    c.heading ?? '',
    '',
    c.greeting ?? '',
    ...c.paragraphs,
    c.card ? [c.card.ref, c.card.title, c.card.status?.label].filter(Boolean).join(' · ') : '',
    ...(c.card?.facts ?? []).map(([k, v]) => `${k}: ${v}`),
    ...(c.stats ?? []).map(([k, v]) => `${k}: ${v}`),
    ...(c.facts ?? []).map(([k, v]) => `${k}: ${v}`),
    c.quote?.text.trim() ? `\n${c.quote.label}:\n${c.quote.text.trim()}` : '',
    c.button ? `\n${c.button.label}: ${c.button.url}` : '',
    c.hint ? `\n${c.hint}` : '',
    sig ? `\n-- \n${sig.text}` : '',
    '\n',
    c.footer,
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  return { html, text };
}

/** Attachment entry for the inline header logo. */
export const logoAttachment = (brand: MailBrand) => (brand.logo ? [{ filename: 'logo', content: brand.logo.content, contentType: brand.logo.contentType, cid: brand.logo.cid }] : []);

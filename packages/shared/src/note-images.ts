/**
 * Images pasted into ticket texts (notes, description, resolution, time
 * entries, e-mails) are stored as attachments and referenced with a markdown
 * image tag: `![name](/api/v1/attachments/file/<id>?inline=true)`.
 *
 * Only these exact URL shapes are ever rendered as images; any other
 * `![..](..)` stays plain text.
 */

/** Staff URL of an attachment shown inline. */
export const NOTE_IMAGE_URL_RE = /^\/api\/v1\/attachments\/file\/(\d+)(\?inline=true)?$/;
/** Portal URL of an image on one of the contact's tickets. */
export const PORTAL_IMAGE_URL_RE = /^\/api\/portal\/tickets\/(\d+)\/images\/(\d+)$/;

/** Any markdown image tag (alt text without line breaks or brackets, URL without spaces). */
const MD_IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

export function noteImageMarkdown(name: string, attachmentId: number) {
  const alt = name.replace(/[[\]\n\r]/g, ' ').trim() || 'image';
  return `![${alt}](/api/v1/attachments/file/${attachmentId}?inline=true)`;
}

export type NoteSegment = { type: 'text'; text: string } | { type: 'image'; alt: string; url: string };

/** Splits a text into plain text and image segments; only URLs matching `allow` become images. */
export function splitNoteImages(text: string, allow: RegExp[] = [NOTE_IMAGE_URL_RE]): NoteSegment[] {
  const out: NoteSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MD_IMAGE_RE)) {
    const url = m[2]!;
    if (!allow.some((re) => re.test(url))) continue;
    if (m.index! > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    out.push({ type: 'image', alt: m[1]!.trim(), url });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** Attachment ids of the (staff URL) images referenced in a text. */
export function noteImageIds(text: string | null | undefined): number[] {
  if (!text) return [];
  const ids = new Set<number>();
  for (const seg of splitNoteImages(text)) {
    if (seg.type === 'image') ids.add(Number(NOTE_IMAGE_URL_RE.exec(seg.url)![1]));
  }
  return [...ids];
}

/** Rewrites each staff image tag with `fn` (returning the replacement text). */
export function replaceNoteImages(text: string, fn: (img: { alt: string; attachmentId: number }) => string): string {
  return splitNoteImages(text)
    .map((seg) => (seg.type === 'text' ? seg.text : fn({ alt: seg.alt, attachmentId: Number(NOTE_IMAGE_URL_RE.exec(seg.url)![1]) })))
    .join('');
}

/** Plain-text form for e-mails and notifications: images become "[image: name]". */
export function noteImagesToText(text: string): string {
  return replaceNoteImages(text, ({ alt }) => `[image: ${alt || 'image'}]`);
}

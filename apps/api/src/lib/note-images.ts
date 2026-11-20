import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { noteImageIds, noteImagesToText, replaceNoteImages } from '@taskora/shared';
import type { Tx } from '../db/client.js';
import * as s from '../db/schema/index.js';

export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Prepares a ticket text that may contain pasted images for an e-mail: the
 * image tags become "[image: name]" and the images that belong to the ticket
 * are returned as e-mail attachments (files of other records are ignored).
 */
export async function emailTextWithImages(db: Tx, uploadDir: string, ticketId: number, text: string, skipIds: number[] = []) {
  const ids = noteImageIds(text).filter((id) => !skipIds.includes(id));
  const files = ids.length
    ? await db
        .select()
        .from(s.attachments)
        .where(and(eq(s.attachments.entityType, 'ticket'), eq(s.attachments.entityId, ticketId), inArray(s.attachments.id, ids)))
    : [];
  const root = resolve(uploadDir);
  const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
  for (const f of files) {
    const path = join(root, f.storageKey);
    if (!path.startsWith(root)) continue;
    const content = await readFile(path).catch(() => null);
    if (content) attachments.push({ filename: f.fileName, contentType: f.mimeType, content });
  }
  return { text: noteImagesToText(text), attachments, attachmentIds: files.map((f) => f.id) };
}

/** Points staff image URLs of a ticket text at the portal's image endpoint for that ticket. */
export function portalImageUrls(text: string | null, ticketId: number): string | null {
  if (!text) return text;
  return replaceNoteImages(text, ({ alt, attachmentId }) => `![${alt}](/api/portal/tickets/${ticketId}/images/${attachmentId})`);
}

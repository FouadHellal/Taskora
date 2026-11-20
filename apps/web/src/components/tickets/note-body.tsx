import { Fragment, useMemo } from 'react';
import { NOTE_IMAGE_URL_RE, splitNoteImages } from '@taskora/shared';
import { cn } from '@/lib/utils';

const STAFF_IMAGES = [NOTE_IMAGE_URL_RE];

/** Attachment images are always requested for inline display. */
function inlineUrl(url: string) {
  return NOTE_IMAGE_URL_RE.test(url) && !url.endsWith('?inline=true') ? `${url}?inline=true` : url;
}

/**
 * Safe rendering of ticket texts (notes, description, resolution, time
 * entries): plain text with its line breaks, where pasted images
 * (`![name](/api/v1/attachments/file/<id>?inline=true)`) are shown as images.
 * Text is never interpreted as HTML, and only whitelisted image URLs render.
 */
export function NoteBody({ text, className, allow = STAFF_IMAGES, thumbs }: { text: string | null | undefined; className?: string; allow?: RegExp[]; thumbs?: boolean }) {
  const segments = useMemo(() => splitNoteImages(text ?? '', allow), [text, allow]);
  return (
    <div className={cn('prose-note', className)}>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <Fragment key={i}>{seg.text}</Fragment>
        ) : (
          <a key={i} href={inlineUrl(seg.url)} target="_blank" rel="noopener noreferrer" className="my-1 inline-block max-w-full align-top" title={`${seg.alt || 'Image'} (open full size)`}>
            <img
              src={inlineUrl(seg.url)}
              alt={seg.alt}
              loading="lazy"
              className={cn('max-w-full rounded-md border border-border bg-surface-2 object-contain', thumbs ? 'max-h-24' : 'max-h-[28rem]')}
            />
          </a>
        ),
      )}
    </div>
  );
}

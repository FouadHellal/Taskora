import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type TextareaHTMLAttributes } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus } from 'lucide-react';
import { toast } from 'sonner';
import { noteImageMarkdown } from '@taskora/shared';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Textarea } from '../ui/input';

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const pad = (n: number) => String(n).padStart(2, '0');

/** `screenshot-YYYYMMDD-HHmmss.png` (local time), with a suffix for several images. */
export function screenshotName(type: string, at = new Date(), index = 0) {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `screenshot-${stamp}${index ? `-${index + 1}` : ''}.${IMAGE_TYPES[type] ?? 'png'}`;
}

function filesOf(list: DataTransferItemList | null | undefined, files: FileList | null | undefined): File[] {
  const out = [...(files ?? [])];
  if (!out.length && list) for (const item of list) if (item.kind === 'file') out.push(...[item.getAsFile()].filter((f): f is File => !!f));
  return out;
}

/**
 * Paste / drag-and-drop of images into a ticket text: each image is uploaded
 * as a ticket attachment and a markdown image tag is inserted at the cursor
 * (an "Uploading…" placeholder is shown meanwhile).
 */
export function useImagePaste({
  ticketId,
  value,
  onValueChange,
  textarea,
}: {
  ticketId?: number | null;
  value: string;
  onValueChange: (v: string) => void;
  textarea: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const qc = useQueryClient();
  const latest = useRef(value);
  latest.current = value;
  const [uploading, setUploading] = useState(0);
  const set = (v: string) => {
    latest.current = v;
    onValueChange(v);
  };

  const insert = async (files: File[], pasted: boolean) => {
    if (!ticketId) return;
    const now = new Date();
    const named = files.map((f, i) => (pasted || !f.name || /^image\.\w+$/i.test(f.name) ? new File([f], screenshotName(f.type, now, i), { type: f.type }) : f));
    const tokens = named.map((f, i) => `![Uploading ${f.name}…${i ? ` ${i + 1}` : ''}]()`);
    const el = textarea.current;
    const cur = latest.current;
    const start = el ? el.selectionStart : cur.length;
    const end = el ? el.selectionEnd : cur.length;
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    const block = `${before && !before.endsWith('\n') ? '\n' : ''}${tokens.join('\n')}${after.startsWith('\n') ? '' : '\n'}`;
    set(before + block + after);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = (before + block).length;
    });

    setUploading((n) => n + named.length);
    await Promise.all(
      named.map(async (file, i) => {
        try {
          const res = await api.upload<{ data: { id: number; fileName: string }[] }>(`/attachments/ticket/${ticketId}`, [file]);
          const row = res.data[0]!;
          set(latest.current.replace(tokens[i]!, noteImageMarkdown(row.fileName, row.id)));
        } catch (e) {
          set(latest.current.replace(`${tokens[i]}\n`, '').replace(tokens[i]!, ''));
          toast.error(`Could not upload ${file.name}${e instanceof ApiError ? `: ${e.message}` : ''}`);
        } finally {
          setUploading((n) => n - 1);
        }
      }),
    );
    qc.invalidateQueries({ queryKey: ['attachments', 'ticket', ticketId] });
    qc.invalidateQueries({ queryKey: ['timeline', ticketId] });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!ticketId) return;
    const files = filesOf(e.clipboardData?.items, e.clipboardData?.files);
    const images = files.filter((f) => IMAGE_TYPES[f.type]);
    // Office apps put both text and a picture of it on the clipboard: keep the text.
    if (!images.length || e.clipboardData.types.includes('text/plain')) return;
    e.preventDefault();
    void insert(images, true);
  };

  const onDragOver = (e: DragEvent<HTMLTextAreaElement>) => {
    if (ticketId && e.dataTransfer.types.includes('Files')) e.preventDefault();
  };

  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    if (!ticketId) return;
    const files = filesOf(null, e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    const images = files.filter((f) => IMAGE_TYPES[f.type]);
    if (images.length < files.length) toast.info('Only PNG, JPEG, GIF and WebP images can be dropped into the text; add other files on the Attachments tab.');
    if (images.length) void insert(images, false);
  };

  return { onPaste, onDragOver, onDrop, uploading };
}

type ImageTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  /** Ticket the pasted images are attached to; without one, pasting behaves normally. */
  ticketId?: number | null;
  value: string;
  onValueChange: (v: string) => void;
  /** Reports whether images are still uploading (e.g. to disable a submit button). */
  onBusyChange?: (busy: boolean) => void;
  hint?: boolean;
  wrapperClassName?: string;
};

/** Textarea that accepts pasted and dropped images (see `useImagePaste`). */
export const ImageTextarea = forwardRef<HTMLTextAreaElement, ImageTextareaProps>(function ImageTextarea(
  { ticketId, value, onValueChange, onBusyChange, hint = true, wrapperClassName, onPaste, onDrop, onDragOver, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!, []);
  const paste = useImagePaste({ ticketId, value, onValueChange, textarea: inner });
  const busy = paste.uploading > 0;
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const reported = useRef(false);
  useEffect(() => {
    if (busy === reported.current) return;
    reported.current = busy;
    busyCallback.current?.(busy);
  }, [busy]);
  return (
    <div className={cn('min-w-0', wrapperClassName)}>
      <Textarea
        ref={inner}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onPaste={(e) => {
          onPaste?.(e);
          if (!e.defaultPrevented) paste.onPaste(e);
        }}
        onDragOver={(e) => {
          onDragOver?.(e);
          paste.onDragOver(e);
        }}
        onDrop={(e) => {
          onDrop?.(e);
          if (!e.defaultPrevented) paste.onDrop(e);
        }}
        {...rest}
      />
      {hint && ticketId ? (
        <div className={cn('mt-1 flex items-center gap-1 text-[11px]', busy ? 'text-primary' : 'text-subtle')}>
          <ImagePlus className={cn('size-3', busy && 'animate-pulse')} />
          {busy ? `Uploading image${paste.uploading > 1 ? 's' : ''}…` : 'Paste or drop images'}
        </div>
      ) : null}
    </div>
  );
});

import { useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

function initialsOf(name?: string | null) {
  return (
    (name ?? '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('') || '?'
  );
}

function hueOf(name?: string | null) {
  let h = 0;
  for (const c of name ?? '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function logoUrl(kind: 'company' | 'organization' | 'email', id: number | null | undefined, version: string | null | undefined) {
  if (!version) return null;
  const v = encodeURIComponent(version);
  if (kind === 'email') return `/api/v1/logos/email?v=${v}`;
  return kind === 'organization' ? `/api/v1/logos/organization?v=${v}` : `/api/v1/logos/company/${id}?v=${v}`;
}

/** Company logo, or coloured initials when the company has none. */
export function CompanyLogo({
  companyId,
  name,
  logoUpdatedAt,
  className,
}: {
  companyId: number | null | undefined;
  name?: string | null;
  logoUpdatedAt?: string | null;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const src = companyId ? logoUrl('company', companyId, logoUpdatedAt) : null;
  if (src && !broken) {
    return <img src={src} alt="" title={name ?? undefined} onError={() => setBroken(true)} className={cn('size-6 shrink-0 rounded bg-white object-contain ring-1 ring-border', className)} />;
  }
  return (
    <span
      className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white', className)}
      style={{ backgroundColor: `hsl(${hueOf(name)} 40% 46%)` }}
      title={name ?? undefined}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * Reads an image file and scales it down to fit `max`×`max`, returning a PNG
 * data URL. Scaling keeps uploads small and turns SVG/BMP/… into a raster
 * format the API accepts.
 */
export async function imageToDataUrl(file: File, max = 256): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('This file is not an image the browser can read'));
      i.src = url;
    });
    const w = img.naturalWidth || max;
    const h = img.naturalHeight || max;
    const scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Upload / replace / remove buttons for a company or organization logo. */
export function LogoEditor({
  kind,
  id,
  name,
  logoUpdatedAt,
  onChanged,
  disabled,
  maxSize = 256,
  previewBg,
}: {
  kind: 'company' | 'organization' | 'email';
  /** Longest side of the uploaded image, in pixels. */
  maxSize?: number;
  /** Background behind the preview (e.g. the e-mail header colour). */
  previewBg?: string;
  id?: number;
  name?: string | null;
  logoUpdatedAt?: string | null;
  onChanged: () => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const path = kind === 'organization' ? '/logos/organization' : kind === 'email' ? '/logos/email' : `/logos/company/${id}`;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError || e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };
  const src = logoUrl(kind, id, logoUpdatedAt);
  return (
    <div className="flex items-center gap-3">
      {kind === 'company' ? (
        <CompanyLogo companyId={id} name={name} logoUpdatedAt={logoUpdatedAt} className="size-14 text-base" />
      ) : src ? (
        <img src={src} alt="" className={kind === 'email' ? 'h-14 max-w-48 rounded object-contain p-1.5 ring-1 ring-border' : 'size-14 rounded bg-white object-contain ring-1 ring-border'} style={{ backgroundColor: previewBg ?? '#ffffff' }} />
      ) : (
        <img src="/favicon.svg" alt="" className="size-14 rounded p-2 opacity-60 ring-1 ring-border" />
      )}
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-1.5">
          <Button size="sm" disabled={disabled} loading={busy} onClick={() => input.current?.click()}>
            <ImagePlus /> {logoUpdatedAt ? 'Replace logo' : 'Upload logo'}
          </Button>
          {logoUpdatedAt && (
            <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => run(() => api.delete(path), 'Logo removed')} aria-label="Remove logo">
              <Trash2 />
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted">PNG, JPEG, WebP, GIF or SVG — resized to {maxSize} px.</p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) return void toast.error('Choose an image smaller than 10 MB');
          void run(async () => api.put(path, { dataUrl: await imageToDataUrl(file, maxSize) }), 'Logo updated');
        }}
      />
    </div>
  );
}

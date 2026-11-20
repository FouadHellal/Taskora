import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eraser, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, request, setForceDeleteHandler } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from './ui/button';
import { Input, Select } from './ui/input';
import { Dialog } from './ui/overlays';
import { Spinner } from './ui/misc';

interface Preview {
  table: string;
  id: number;
  name: string;
  reassign: boolean;
  options?: { id: number; name: string }[];
  removed: { table: string; label: string; count: number }[];
  cleared: { table: string; column: string; label: string; count: number }[];
  files: number;
}

interface Pending {
  path: string;
  error: ApiError;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/**
 * Super administrators: when a delete is refused because the record is still in use, this
 * dialog shows exactly what else would be removed (or which references would be cleared)
 * and lets them delete it anyway. Mounted once; it hooks into api.delete() for every page.
 */
export function ForceDeleteHost() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<'reassign' | 'cascade'>('reassign');
  const [replaceWith, setReplaceWith] = useState<string>('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const superAdmin = !!me?.superAdmin;
  useEffect(() => {
    if (!superAdmin) {
      setForceDeleteHandler(null);
      return;
    }
    setForceDeleteHandler(
      (path, error) =>
        new Promise((resolve, reject) => {
          pendingRef.current?.reject(new ApiError(409, 'cancelled', 'Delete cancelled'));
          setPreview(null);
          setLoadError(null);
          setTyped('');
          setReplaceWith('');
          setMode('reassign');
          setPending({ path, error, resolve, reject });
        }),
    );
    return () => setForceDeleteHandler(null);
  }, [superAdmin]);

  const base = pending?.path.split('?')[0];
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    request<Preview>('DELETE', base, undefined, { query: { force: 'preview' }, noForce: true })
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        if (!p.reassign) setMode('cascade');
        else if (p.options?.[0]) setReplaceWith(String(p.options[0].id));
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : 'Could not load the preview'));
    return () => {
      cancelled = true;
    };
  }, [base]);

  if (!pending) return null;

  const close = () => {
    pending.reject(new ApiError(409, 'cancelled', 'Delete cancelled — the record was kept.'));
    setPending(null);
  };

  const reassigning = !!preview?.reassign && mode === 'reassign';
  const removedTotal = preview?.removed.reduce((n, r) => n + r.count, 0) ?? 0;
  const mustType = !reassigning && removedTotal > 0;
  const canConfirm = !!preview && (!mustType || typed.trim().toUpperCase() === 'DELETE') && (!reassigning || !!replaceWith);

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await request('DELETE', base!, undefined, {
        query: { force: 'true', ...(reassigning ? { replaceWith } : {}) },
        noForce: true,
      });
      toast.success(`“${preview?.name}” deleted${removedTotal && !reassigning ? ` with ${removedTotal} related record${removedTotal === 1 ? '' : 's'}` : ''}`);
      setPending(null);
      pending.resolve(res);
      void qc.invalidateQueries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Force delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      title={preview ? `Force delete “${preview.name}”?` : 'Force delete?'}
      description={pending.error.message}
      size="md"
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" onClick={confirm} loading={busy} disabled={!canConfirm}>
            <Trash2 /> Force delete
          </Button>
        </>
      }
    >
      {!preview && !loadError && (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner /> Checking what depends on this record…
        </div>
      )}
      {loadError && <p className="text-[13px] text-danger">{loadError}</p>}
      {preview && (
        <div className="space-y-4 text-[13px]">
          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning-soft/40 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>
              You are a super administrator, so you can delete this record even though other records still use it. This cannot be undone — consider a backup
              first (Administration → Backup &amp; Restore).
            </p>
          </div>

          {preview.reassign && (
            <div className="space-y-2">
              <label className="flex items-start gap-2">
                <input type="radio" className="mt-1" checked={mode === 'reassign'} onChange={() => setMode('reassign')} />
                <span>
                  <b>Move everything that uses it to:</b>
                  <Select
                    className="mt-1.5"
                    value={replaceWith}
                    onChange={(e) => setReplaceWith(e.target.value)}
                    disabled={mode !== 'reassign'}
                    options={(preview.options ?? []).map((o) => ({ value: String(o.id), label: o.name }))}
                  />
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" className="mt-1" checked={mode === 'cascade'} onChange={() => setMode('cascade')} />
                <span>
                  <b>Delete it and everything that depends on it</b>
                </span>
              </label>
            </div>
          )}

          {reassigning ? (
            preview.cleared.length > 0 && (
              <ul className="space-y-1">
                {preview.cleared.map((c) => (
                  <li key={`${c.table}.${c.column}`} className="flex justify-between gap-3">
                    <span className="text-muted">{c.label}</span>
                    <span className="tabular-nums">{c.count} moved</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              {preview.removed.length > 0 ? (
                <div>
                  <div className="mb-1 flex items-center gap-1.5 font-medium text-danger">
                    <Trash2 className="size-3.5" /> Also deleted
                  </div>
                  <ul className="space-y-1">
                    {preview.removed.map((r) => (
                      <li key={r.table} className="flex justify-between gap-3">
                        <span>{r.label}</span>
                        <span className="tabular-nums font-medium">{r.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-muted">Nothing else will be deleted.</p>
              )}
              {preview.cleared.length > 0 && (
                <div>
                  <div className="mb-1 flex items-center gap-1.5 font-medium">
                    <Eraser className="size-3.5" /> Links cleared (records kept)
                  </div>
                  <ul className="space-y-1">
                    {preview.cleared.map((c) => (
                      <li key={`${c.table}.${c.column}`} className="flex justify-between gap-3">
                        <span className="text-muted">{c.label}</span>
                        <span className="tabular-nums">{c.count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {mustType && (
                <div>
                  <div className="mb-1 text-xs text-muted">
                    Type <b>DELETE</b> to confirm
                  </div>
                  <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" autoComplete="off" />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

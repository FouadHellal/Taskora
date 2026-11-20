/** Thin fetch wrapper for the Taskora API: JSON, cookies, CSRF and typed errors. */

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>;

export function qs(params?: Query): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) usp.set(k, v.join(','));
    } else usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/**
 * Called when a DELETE fails because the record is still referenced (409 in_use). Registered by
 * the force-delete dialog for super administrators: it resolves with the forced delete's response,
 * or rejects when the user cancels. Callers of api.delete() see a normal success in that case.
 */
type ForceDeleteHandler = (path: string, error: ApiError) => Promise<unknown>;
let forceDeleteHandler: ForceDeleteHandler | null = null;
export function setForceDeleteHandler(fn: ForceDeleteHandler | null) {
  forceDeleteHandler = fn;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: { query?: Query; raw?: boolean; noForce?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/api/v1${path}${qs(opts.query)}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (opts.raw) {
    if (!res.ok) throw new ApiError(res.status, 'error', res.statusText);
    return res as unknown as T;
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: { fields?: Record<string, string> } } })?.error;
    if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/login') && !path.startsWith('/setup')) onUnauthorized();
    const error = new ApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText, err?.details?.fields ?? {});
    if (method === 'DELETE' && res.status === 409 && error.code === 'in_use' && forceDeleteHandler && !opts.noForce) {
      return (await forceDeleteHandler(path, error)) as T;
    }
    throw error;
  }
  return data as T;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  delete: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    return request<T>('POST', path, fd);
  },
};

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Triggers a browser download for an API file endpoint (CSV/PDF). */
export function downloadUrl(path: string, query?: Query) {
  const a = document.createElement('a');
  a.href = `/api/v1${path}${qs(query)}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

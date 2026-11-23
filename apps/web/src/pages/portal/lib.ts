import { useQuery } from '@tanstack/react-query';
import { PORTAL_IMAGE_URL_RE } from '@taskora/shared';
import { translate } from '@/lib/i18n';

/** Pasted images are served to the portal by its own image endpoint. */
export const PORTAL_IMAGES = [PORTAL_IMAGE_URL_RE];

/* Minimal client for the separate portal API realm (own cookie + CSRF). */
let portalCsrf: string | null = null;
export const setPortalCsrf = (token: string | null) => {
  portalCsrf = token;
};

export class PortalError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function papi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`/api/portal${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' && portalCsrf ? { 'x-csrf-token': portalCsrf } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new PortalError(res.status, translate(data?.error?.message ?? res.statusText));
  return data as T;
}

export interface PortalFeatures {
  time: boolean;
  devices: boolean;
  contracts: boolean;
  docs: boolean;
  priority: boolean;
  attachments: boolean;
}

export interface Me {
  contact: {
    id: number;
    firstName: string;
    lastName: string;
    email: string;
    companyId: number;
    companyName: string;
    isManager: boolean;
  } | null;
  features?: PortalFeatures;
  welcome?: string;
  organizationName: string;
  logoUpdatedAt?: string | null;
  language?: string;
  csrfToken?: string;
}

export function usePortalMe() {
  return useQuery({
    queryKey: ['portal-me'],
    queryFn: async () => {
      const me = await papi<Me>('GET', '/me');
      setPortalCsrf(me.csrfToken ?? null);
      return me;
    },
    retry: false,
    staleTime: 60_000,
  });
}

export interface PTicket {
  id: number;
  ticketNumber: string;
  title: string;
  statusName: string;
  statusColor: string;
  statusCategory: string;
  priorityName: string;
  priorityColor: string | null;
  contactName: string | null;
  assignedName: string | null;
  createdAt: string;
  lastActivityAt: string;
  resolvedAt: string | null;
  workedMinutes: number;
}

export interface PTicketDetail extends PTicket {
  description: string | null;
  resolution: string | null;
  deviceName: string | null;
  notes: { id: number; body: string; author: string | null; fromCustomer: boolean; createdAt: string }[];
  timeEntries: { id: number; startedAt: string; minutes: number; description: string; technician: string | null }[];
  files: { id: number; fileName: string; mimeType: string; sizeBytes: number; createdAt: string; fromClient: boolean }[];
}

/** "45 min", "2 h", "1 h 30" — easy to read for clients. */
export function fmtMinutes(min: number | null | undefined) {
  const m = Math.max(0, Math.round(min ?? 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Client-friendly wording for the status categories. */
export const STATE_LABEL: Record<string, string> = {
  new: 'Received',
  open: 'In progress',
  waiting: 'Waiting for you',
  resolved: 'Resolved',
  closed: 'Closed',
};

const LANG_KEY = 'taskora.portal.lang';
export function storedPortalLanguage(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}
export function storePortalLanguage(lang: string | null) {
  try {
    if (lang) localStorage.setItem(LANG_KEY, lang);
    else localStorage.removeItem(LANG_KEY);
  } catch {
    /* private mode */
  }
}

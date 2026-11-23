/**
 * TP-Link Omada SDN controller Open API (northbound) client, client-credentials mode.
 *
 * READ-ONLY BY DESIGN: the only non-GET calls are the token request and the documented
 * POST *read* endpoints (v2 client list, client statistics). Nothing is changed on the
 * controller. Secrets never appear in error messages.
 *
 * Flow: GET /api/info → omadacId; POST /openapi/authorize/token?grant_type=client_credentials
 * → accessToken; then `Authorization: AccessToken=<token>` on /openapi/v1|v2/{omadacId}/…
 * Responses are `{ errorCode, msg, result }` (errorCode 0 = success, even with HTTP 200).
 * On-premise controllers (OC200/OC300, software controller on :8043) usually serve a
 * self-signed certificate, hence the `verifyTls` switch.
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

export class OmadaError extends Error {
  constructor(
    public status: number,
    public code: number | string,
    message: string,
  ) {
    super(message);
    this.name = 'OmadaError';
  }
}

export interface OmadaHttpResponse {
  status: number;
  body: unknown;
  retryAfter?: number | null;
}

export type OmadaTransport = (req: { method: string; url: string; headers: Record<string, string>; body?: string }) => Promise<OmadaHttpResponse>;

/** HTTP(S) transport that can accept self-signed certificates. */
export function nodeTransport(verifyTls: boolean, timeoutMs = 20_000): OmadaTransport {
  return (req) =>
    new Promise((resolve, reject) => {
      const url = new URL(req.url);
      const isHttps = url.protocol === 'https:';
      const fn = isHttps ? httpsRequest : httpRequest;
      const r = fn(
        url,
        { method: req.method, headers: req.headers, timeout: timeoutMs, ...(isHttps ? { rejectUnauthorized: verifyTls } : {}) },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: unknown = null;
            try {
              body = text ? JSON.parse(text) : null;
            } catch {
              body = { errorCode: -1, msg: text.slice(0, 200) };
            }
            const ra = Number(res.headers['retry-after']);
            resolve({ status: res.statusCode ?? 0, body, retryAfter: Number.isFinite(ra) ? ra : null });
          });
        },
      );
      r.on('timeout', () => r.destroy(new Error('The controller did not answer in time')));
      r.on('error', (err: NodeJS.ErrnoException) => {
        const hint =
          err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
            ? 'The controller uses a self-signed certificate: untick "Verify the TLS certificate"'
            : err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT'
              ? `Cannot reach the controller (${err.code}): check the address, the port (usually 8043 or 443) and the firewall`
              : err.message;
        reject(new OmadaError(0, err.code ?? 'network', hint));
      });
      if (req.body) r.write(req.body);
      r.end();
    });
}

export interface OmadaClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  omadacId?: string | null;
  verifyTls?: boolean;
  transport?: OmadaTransport;
  sleep?: (ms: number) => Promise<void>;
}

type Envelope<T> = { errorCode: number; msg?: string; result?: T };
type Page<T> = { totalRows?: number; currentPage?: number; data?: T[] };

const TOKEN_ERRORS = new Set([-44112, -44113]);

export class OmadaClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private omadacId: string | null;
  private transport: OmadaTransport;
  private sleep: (ms: number) => Promise<void>;
  private base: string;
  /** Controllers without the v2 client list (software controller 5.15, Fusion) fall back to v1. */
  private clientsV1 = false;

  constructor(private opts: OmadaClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.omadacId = opts.omadacId?.trim() || null;
    this.transport = opts.transport ?? nodeTransport(opts.verifyTls ?? false);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Controller id and version (GET /api/info, no authentication). */
  async info(): Promise<{ omadacId: string; controllerVer: string | null; apiVer: string | null }> {
    const res = await this.transport({ method: 'GET', url: `${this.base}/api/info`, headers: { accept: 'application/json' } });
    const env = res.body as Envelope<{ omadacId?: string; controllerVer?: string; apiVer?: string }> | null;
    if (res.status >= 400 || !env || env.errorCode !== 0 || !env.result?.omadacId) {
      throw new OmadaError(res.status, env?.errorCode ?? 'info', 'This address does not answer like an Omada controller (/api/info)');
    }
    this.omadacId ??= env.result.omadacId;
    return { omadacId: env.result.omadacId, controllerVer: env.result.controllerVer ?? null, apiVer: env.result.apiVer ?? null };
  }

  private async ensureId() {
    if (!this.omadacId) await this.info();
    return this.omadacId!;
  }

  private async authenticate(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const omadacId = await this.ensureId();
    const res = await this.transport({
      method: 'POST',
      url: `${this.base}/openapi/authorize/token?grant_type=client_credentials`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ omadacId, client_id: this.opts.clientId, client_secret: this.opts.clientSecret }),
    });
    const env = res.body as Envelope<{ accessToken?: string; expiresIn?: number }> | null;
    if (!env || env.errorCode !== 0 || !env.result?.accessToken) {
      throw new OmadaError(res.status, env?.errorCode ?? 'auth', `The controller refused the credentials (${env?.msg ?? `HTTP ${res.status}`}): check the Client ID, the secret and that the app uses Client mode`);
    }
    this.token = env.result.accessToken;
    this.tokenExpiresAt = Date.now() + (env.result.expiresIn ?? 7200) * 1000;
    return this.token;
  }

  /** Authenticated Open API call with token renewal and rate-limit back-off. */
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const omadacId = await this.ensureId();
    const url = `${this.base}/openapi/${path.replace('{omadacId}', encodeURIComponent(omadacId))}`;
    let renewed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const token = await this.authenticate();
      const res = await this.transport({
        method,
        url,
        headers: { authorization: `AccessToken=${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const env = res.body as Envelope<T> | null;
      if ((res.status === 401 || (env && TOKEN_ERRORS.has(env.errorCode))) && !renewed) {
        renewed = true;
        await this.authenticate(true);
        continue;
      }
      if (res.status === 429 || env?.errorCode === -7132) {
        await this.sleep(Math.min(60_000, (res.retryAfter ? res.retryAfter * 1000 : 2000 * 2 ** attempt)));
        continue;
      }
      if (res.status === 404 || !env || env.errorCode !== 0) {
        throw new OmadaError(res.status, env?.errorCode ?? res.status, `Omada API ${path.split('?')[0]}: ${env?.msg ?? `HTTP ${res.status}`}`);
      }
      return env.result as T;
    }
    throw new OmadaError(429, -7132, 'The controller keeps rate-limiting the requests; try again later');
  }

  private async paged<T>(fetchPage: (page: number) => Promise<Page<T> | T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 200; page++) {
      const r = await fetchPage(page);
      const rows = Array.isArray(r) ? r : (r.data ?? []);
      out.push(...rows);
      const total = Array.isArray(r) ? rows.length : (r.totalRows ?? rows.length);
      if (Array.isArray(r) || rows.length < 100 || out.length >= total) break;
    }
    return out;
  }

  sites() {
    return this.paged<Record<string, unknown>>((page) => this.call('GET', `v1/{omadacId}/sites?page=${page}&pageSize=100`));
  }

  devices(siteId: string) {
    return this.paged<Record<string, unknown>>((page) => this.call('GET', `v1/{omadacId}/sites/${encodeURIComponent(siteId)}/devices?page=${page}&pageSize=100`));
  }

  /** Online clients of a site (v2 POST list; v1 GET on controllers without it). */
  async clients(siteId: string) {
    const site = encodeURIComponent(siteId);
    if (!this.clientsV1) {
      try {
        return await this.paged<Record<string, unknown>>((page) => this.call('POST', `v2/{omadacId}/sites/${site}/clients`, { page, pageSize: 100, scope: 1, filters: {} }));
      } catch (err) {
        if (!(err instanceof OmadaError) || (err.status !== 404 && err.code !== -1600)) throw err;
        this.clientsV1 = true;
      }
    }
    return this.paged<Record<string, unknown>>((page) => this.call('GET', `v1/{omadacId}/sites/${site}/clients?page=${page}&pageSize=100`));
  }

  /** Clients per band for devices (best effort: not every controller version has it). */
  async clientStats(siteId: string, macs: string[]): Promise<Record<string, unknown>[]> {
    if (!macs.length) return [];
    try {
      const r = await this.call<Record<string, unknown>[] | { data?: Record<string, unknown>[] }>('POST', 'v1/{omadacId}/clients/stat/devices', { devices: macs.map((mac) => ({ mac, siteId })) });
      return Array.isArray(r) ? r : (r?.data ?? []);
    } catch {
      return [];
    }
  }

  /** Checks address, credentials and permissions; returns the sites. */
  async testConnection() {
    const info = await this.info();
    const sites = await this.sites();
    return { controllerVersion: info.controllerVer, sites: sites.map((x) => ({ id: String(x.siteId ?? x.id ?? ''), name: String(x.name ?? '') })) };
  }
}

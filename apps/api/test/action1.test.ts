import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { formatNumber } from '@taskora/shared';
import { schema as s } from '../src/db/client.js';
import { nextSequence } from '../src/lib/query.js';
import { Action1Client, Action1Error } from '../src/integrations/action1/client.js';
import {
  guessCiTypeName,
  matchContactCandidates,
  normalizeEndpoint,
  parseAction1Date,
  parseYesNo,
  usableSerial,
} from '../src/integrations/action1/normalize.js';
import { buildAction1Client, runAction1Sync } from '../src/integrations/action1/sync.js';
import { createTestApp, makeCompany, userClient, type Client, type TestContext } from './helpers.js';

/* All data below is fictional. */

const ORG_NS = '7c1e2a90-1111-4a6b-9c55-0a0a0a0a0001';
const ORG_BP = '7c1e2a90-1111-4a6b-9c55-0a0a0a0a0002';
const EP_LAPTOP = 'e5a0c3f2-2222-4d7e-8f10-0b0b0b0b0014';
const EP_DESK = 'e5a0c3f2-2222-4d7e-8f10-0b0b0b0b0021';
const EP_SRV = 'e5a0c3f2-2222-4d7e-8f10-0b0b0b0b0031';
const EP_SHARED = 'e5a0c3f2-2222-4d7e-8f10-0b0b0b0b0041';
const EP_BP = 'e5a0c3f2-2222-4d7e-8f10-0b0b0b0b0051';
const CLIENT_ID = 'api-key-00000000-test@action1.example';
const CLIENT_SECRET = 'fake-secret-NOT-REAL-9f8e7d';

function endpoint(id: string, org: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'Endpoint',
    self: `https://app.eu.action1.com/api/3.0/endpoints/managed/${org}/${id}/general`,
    organization_id: org,
    status: 'Connected',
    online_status: 'SUCCESS',
    last_seen: '2026-10-19_08-41-07',
    platform: 'Windows_64',
    OS: 'Windows 11 (24H2)',
    agent_version: '5.300.100.1',
    manufacturer: 'Contoso Devices',
    reboot_required: 'No',
    update_status: 'SUCCESS',
    vulnerability_status: 'SUCCESS',
    missing_updates: { critical: 0, other: 0 },
    ...overrides,
  };
}

function initialEndpoints(): Record<string, Record<string, unknown>[]> {
  return {
    [ORG_NS]: [
      endpoint(EP_LAPTOP, ORG_NS, {
        name: 'NS-LAPTOP-014',
        device_name: 'NS-LAPTOP-014',
        address: '10.20.30.114',
        MAC: '3C:52:82:00:00:14',
        last_boot_time: '2026-10-18_07-55-12',
        user: 'NORTHSTAR\\emma.smith',
        serial: 'FAKE5CD0014',
        CPU_name: 'Intel(R) Core(TM) i7-1365U',
        RAM: '16Gb DDR5',
        disk: '512Gb SSD',
        reboot_required: 'Yes',
        update_status: 'ERROR',
        missing_updates: { critical: 2, other: 5 },
      }),
      endpoint(EP_DESK, ORG_NS, {
        name: 'Reception PC',
        device_name: 'NS-DESK-021',
        status: 'Disconnected',
        online_status: 'WARNING',
        last_seen: '2026-10-02_16-03-44',
        address: '10.20.30.121',
        OS: 'Windows 10 (22H2)',
        user: 'NORTHSTAR\\reception',
        serial: '0',
        missing_updates: { critical: 0, other: 3 },
      }),
      endpoint(EP_SRV, ORG_NS, {
        name: 'NS-SRV-01',
        device_name: 'NS-SRV-01',
        OS: 'Windows Server 2022',
        address: '10.20.30.10',
        user: 'AzureAD\\LiamBrown',
        serial: 'FAKE-SRV-0031',
      }),
      endpoint(EP_SHARED, ORG_NS, {
        name: 'NS-LAPTOP-041',
        device_name: 'NS-LAPTOP-041',
        user: 'emma.smith@northstar.example',
        serial: 'FAKE-SHARED-01',
      }),
    ],
    [ORG_BP]: [endpoint(EP_BP, ORG_BP, { name: 'BP-WS-001', device_name: 'BP-WS-001', user: 'BLUEPEAK\\emma.smith', serial: 'FAKE-BP-0051' })],
  };
}

/* ------------------------------------------------------- mock Action1 API */

interface MockAction1 {
  url: string;
  server: Server;
  requests: { method: string; path: string; search: string }[];
  orgs: { id: string; name: string; description?: string }[];
  endpoints: Record<string, Record<string, unknown>[]>;
  failOrgs: Set<string>;
  pageSize: number;
  relativeNext: boolean;
  tokensIssued: number;
}

async function startMockAction1(): Promise<MockAction1> {
  const validTokens = new Set<string>();
  const mock = {
    url: '',
    requests: [],
    orgs: [
      { id: ORG_NS, name: 'Northstar Consulting', description: 'Managed customer' },
      { id: ORG_BP, name: 'BluePeak Logistics' },
    ],
    endpoints: initialEndpoints(),
    failOrgs: new Set<string>(),
    pageSize: 2,
    relativeNext: false,
    tokensIssued: 0,
  } as unknown as MockAction1;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      mock.requests.push({ method: req.method ?? '', path: url.pathname, search: url.search });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const error = (status: number, msg: string) => send(status, { id: '0', type: 'Error', status, developer_message: msg, user_message: msg });

      if (req.method === 'POST' && url.pathname === '/api/3.0/oauth2/token') {
        const body = JSON.parse(raw || '{}') as { client_id?: string; client_secret?: string };
        if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return error(401, 'Invalid client credentials.');
        const token = `fake-token-${++mock.tokensIssued}`;
        validTokens.add(token);
        return send(200, { access_token: token, refresh_token: 'fake-refresh', expires_in: 3600, token_type: 'Bearer' });
      }
      if (req.method !== 'GET') return error(405, 'Method not allowed');
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !validTokens.has(auth.slice(7))) return error(401, 'Not authenticated');

      const page = (items: unknown[]) => {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), mock.pageSize);
        const from = Number(url.searchParams.get('from') ?? 0);
        const slice = items.slice(from, from + limit);
        let next = '';
        if (from + limit < items.length) {
          const n = new URL(url.toString());
          n.searchParams.set('from', String(from + limit));
          n.searchParams.set('limit', String(limit));
          next = mock.relativeNext ? `${n.pathname}${n.search}` : `${mock.url}${n.pathname}${n.search}`;
        }
        return send(200, {
          id: '1',
          type: 'ResultPage',
          items: slice,
          total_items: mock.relativeNext ? String(items.length) : items.length,
          limit: String(limit),
          next_page: next,
          prev_page: '',
        });
      };

      if (url.pathname === '/api/3.0/organizations') return page(mock.orgs);
      const m = /^\/api\/3\.0\/endpoints\/managed\/([^/]+)(?:\/([^/]+)\/missing-updates)?$/.exec(url.pathname);
      if (m) {
        const org = decodeURIComponent(m[1]!);
        if (mock.failOrgs.has(org)) return error(500, 'Internal error');
        if (m[2]) {
          return page([
            { id: 'Example_Browser_1700000000001_builtin', type: 'SoftwareRepositoryPackage', name: 'Example Browser', vendor: 'Example Software Ltd', update_type: 'App', versions: [{ version: 'Latest', security_severity: 'Critical' }] },
            { id: 'win_kb5099999', type: 'SoftwareRepositoryPackage', name: '2026-10 Cumulative Update', vendor: 'Microsoft', update_type: 'Windows', kb_number: 'KB5099999', versions: [] },
          ]);
        }
        const fields = url.searchParams.get('fields');
        const items = (mock.endpoints[org] ?? []).map((e) => {
          if (fields === 'missing_updates' || fields === '*') return e;
          const { missing_updates: _omit, ...rest } = e;
          return rest;
        });
        return page(items);
      }
      return error(403, 'Access denied.');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.server = server;
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}

/* -------------------------------------------------------------- fake fetch */

type FakeReply = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(handler: (req: { method: string; url: URL; headers: Record<string, string>; body: string | null }) => FakeReply | Promise<FakeReply>) {
  const calls: { method: string; url: URL; headers: Record<string, string>; body: string | null }[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { method: init?.method ?? 'GET', url, headers, body: typeof init?.body === 'string' ? init.body : null };
    calls.push(call);
    const r = await handler(call);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fn, calls };
}

const tokenReply = (n: number, expiresIn = 3600): FakeReply => ({ status: 200, body: { access_token: `tok-${n}`, expires_in: expiresIn, token_type: 'Bearer' } });
const page = (items: unknown[], extra: Record<string, unknown> = {}): FakeReply => ({
  status: 200,
  body: { id: '1', type: 'ResultPage', items, total_items: items.length, limit: '100', next_page: '', prev_page: '', ...extra },
});

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof Action1Client>[0]> = {}) {
  const sleeps: number[] = [];
  const client = new Action1Client({
    region: 'eu',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, sleeps };
}

/* ====================================================== client unit tests */

describe('Action1Client', () => {
  it('caches the token, refreshes it before expiry and re-authenticates once on 401', async () => {
    let tokens = 0;
    let rejectToken: string | null = null;
    const { fn, calls } = fakeFetch(({ method, url, headers }) => {
      if (method === 'POST') return tokenReply(++tokens);
      if (headers.authorization === `Bearer ${rejectToken}`) return { status: 401, body: { status: 401, user_message: 'expired' } };
      return page([{ id: url.pathname }]);
    });
    let now = Date.UTC(2026, 9, 20, 9, 0, 0);
    const { client } = makeClient(fn, { now: () => now });

    await client.get('/organizations');
    await client.get('/organizations');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/api/3.0/oauth2/token');
    expect(calls[0]!.url.host).toBe('app.eu.action1.com');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(calls[1]!.headers.authorization).toBe('Bearer tok-1');

    // 401 on a cached token → one new token, request retried.
    rejectToken = 'tok-1';
    await client.get('/organizations');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer tok-2');

    // Within 60 s of expiry the token is refreshed proactively.
    now += 3600_000 - 30_000;
    await client.get('/organizations');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3);
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer tok-3');
  });

  it('a persistent 401 fails after a single re-authentication', async () => {
    const { fn, calls } = fakeFetch(({ method }) => (method === 'POST' ? tokenReply(1) : { status: 401, body: { user_message: 'Not authenticated' } }));
    const { client } = makeClient(fn);
    await expect(client.get('/organizations')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('follows absolute and relative next_page links, string total_items and an empty first page', async () => {
    const { fn, calls } = fakeFetch(({ method, url }) => {
      if (method === 'POST') return tokenReply(1);
      const from = Number(url.searchParams.get('from') ?? 0);
      if (from === 0) return page([], { next_page: 'https://app.eu.action1.com/api/3.0/endpoints/managed/org-1?from=1&limit=100&fields=missing_updates', total_items: '3' });
      if (from === 1) return page([{ id: 'a' }, { id: 'b' }], { next_page: '/api/3.0/endpoints/managed/org-1?from=3&limit=100&fields=missing_updates', total_items: '3' });
      return page([{ id: 'c' }], { total_items: '3' });
    });
    const { client } = makeClient(fn);
    const items = await client.listEndpoints('org-1');
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    const gets = calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(3);
    expect(gets[0]!.url.searchParams.get('fields')).toBe('missing_updates');
    expect(gets[0]!.url.searchParams.get('limit')).toBe('100');
  });

  it('pages by from/total_items when next_page is absent, and enforces a page cap', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `o${i}`, name: `Org ${i}` }));
    const { fn } = fakeFetch(({ method, url }) => {
      if (method === 'POST') return tokenReply(1);
      const from = Number(url.searchParams.get('from'));
      const limit = Number(url.searchParams.get('limit'));
      return { status: 200, body: { items: all.slice(from, from + limit), total_items: all.length, next_page: '' } };
    });
    const { client } = makeClient(fn);
    expect(await client.listOrganizations()).toHaveLength(250);

    // A server that always advertises another page must not loop forever.
    let n = 0;
    const loop = fakeFetch(({ method }) => (method === 'POST' ? tokenReply(1) : page([{ id: `x${n}` }], { next_page: `/api/3.0/organizations?from=${++n}` })));
    const capped = makeClient(loop.fn, { maxPages: 5 }).client;
    await expect(capped.listOrganizations()).rejects.toMatchObject({ code: 'pagination_limit' });
    expect(loop.calls.filter((c) => c.method === 'GET')).toHaveLength(5);
  });

  it('refuses to follow a next_page link to another host (never leaks the token)', async () => {
    const { fn, calls } = fakeFetch(({ method }) => (method === 'POST' ? tokenReply(1) : page([{ id: 'a', name: 'A' }], { next_page: 'https://evil.example/api/3.0/organizations?from=1' })));
    const { client } = makeClient(fn);
    await expect(client.listOrganizations()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(calls.every((c) => c.url.host === 'app.eu.action1.com')).toBe(true);
  });

  it('honours 429 Retry-After (header, then body details.retry_after) and then succeeds', async () => {
    let n = 0;
    const { fn } = fakeFetch(({ method }) => {
      if (method === 'POST') return tokenReply(1);
      n++;
      if (n === 1) return { status: 429, headers: { 'retry-after': '2' }, body: { status: 429, details: { retry_after: 2 } } };
      if (n === 2) return { status: 429, body: { status: 429, user_message: 'Request rate limit exceeded', details: { retry_after: 5 } } };
      return page([{ id: 'o1', name: 'Northstar Consulting' }]);
    });
    const { client, sleeps } = makeClient(fn);
    const orgs = await client.listOrganizations();
    expect(orgs).toEqual([expect.objectContaining({ id: 'o1', name: 'Northstar Consulting' })]);
    expect(sleeps).toEqual([2000, 5000]);
  });

  it('retries 5xx and network errors with backoff, then gives up with a typed error', async () => {
    let n = 0;
    const flaky = fakeFetch(({ method }) => {
      if (method === 'POST') return tokenReply(1);
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return { status: 503, body: {} };
      return page([]);
    });
    const a = makeClient(flaky.fn);
    expect(await a.client.listOrganizations()).toEqual([]);
    expect(a.sleeps).toHaveLength(2);
    expect(a.sleeps[1]!).toBeGreaterThanOrEqual(a.sleeps[0]! / 2);

    const down = fakeFetch(({ method }) => (method === 'POST' ? tokenReply(1) : { status: 500, body: { user_message: 'Internal error' } }));
    const b = makeClient(down.fn);
    const err = await b.client.listOrganizations().catch((e) => e);
    expect(err).toBeInstanceOf(Action1Error);
    expect(err).toMatchObject({ status: 500, code: 'http_error' });
    expect(down.calls.filter((c) => c.method === 'GET')).toHaveLength(4);
    expect(b.sleeps).toHaveLength(3);
    // Exponential: each wait is at least the previous base doubled.
    expect(b.sleeps[2]!).toBeGreaterThan(b.sleeps[0]!);
  });

  it('reports bad credentials without exposing the secret or token', async () => {
    const { fn } = fakeFetch(() => ({ status: 401, body: { status: 401, user_message: `Invalid secret ${CLIENT_SECRET}` } }));
    const { client } = makeClient(fn);
    const err = (await client.testConnection().catch((e) => e)) as Action1Error;
    expect(err).toBeInstanceOf(Action1Error);
    expect(err.code).toBe('auth_failed');
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/credentials/i);
    expect(err.message).not.toContain(CLIENT_SECRET);
  });

  it('only issues GET requests besides the token POST', async () => {
    const { fn, calls } = fakeFetch(({ method }) => (method === 'POST' ? tokenReply(1) : page([{ id: 'x', name: 'X' }])));
    const { client } = makeClient(fn);
    await client.testConnection();
    await client.listEndpoints('org');
    await client.getEndpointMissingUpdates('org', 'ep');
    for (const c of calls) {
      if (c.method !== 'GET') expect([c.method, c.url.pathname]).toEqual(['POST', '/api/3.0/oauth2/token']);
    }
  });
});

describe('Action1 normalisation', () => {
  it('parses last_seen as UTC and rejects anything else', () => {
    expect(parseAction1Date('2026-10-19_08-41-07')?.toISOString()).toBe('2026-10-19T08:41:07.000Z');
    expect(parseAction1Date('2026-02-31_00-00-00')).toBeNull();
    expect(parseAction1Date('yesterday')).toBeNull();
    expect(parseAction1Date('')).toBeNull();
    expect(parseAction1Date(undefined)).toBeNull();
  });

  it('maps Yes/No and ignores placeholder serials', () => {
    expect(parseYesNo('Yes')).toBe(true);
    expect(parseYesNo('no')).toBe(false);
    expect(parseYesNo(true)).toBe(true);
    expect(parseYesNo('UNDEFINED')).toBeNull();
    for (const p of ['To be filled by O.E.M.', 'Default string', '0', 'System Serial Number', '', '   ', '0000000']) expect(usableSerial(p)).toBeNull();
    expect(usableSerial('VMware-42 1a 2b 3c')).toBe('VMware-42 1a 2b 3c');
    expect(usableSerial('FAKE5CD0014')).toBe('FAKE5CD0014');
  });

  it('maps an endpoint to snapshot columns without inventing values', () => {
    const [laptop, desk] = initialEndpoints()[ORG_NS]!;
    const a = normalizeEndpoint(laptop!);
    expect(a).toMatchObject({
      name: 'NS-LAPTOP-014',
      deviceName: 'NS-LAPTOP-014',
      osName: 'Windows 11 (24H2)',
      serialNumber: 'FAKE5CD0014',
      ipAddress: '10.20.30.114',
      macAddress: '3C:52:82:00:00:14',
      loggedInUser: 'NORTHSTAR\\emma.smith',
      agentStatus: 'Connected',
      rebootRequired: true,
      missingCriticalUpdates: 2,
      missingOtherUpdates: 5,
      cpu: 'Intel(R) Core(TM) i7-1365U',
      ramText: '16Gb DDR5',
      diskText: '512Gb SSD',
    });
    expect(a.lastBootAt?.toISOString()).toBe('2026-10-18T07:55:12.000Z');
    const b = normalizeEndpoint(desk!);
    expect(b.serialNumber).toBeNull();
    expect(b.cpu).toBeNull();
    expect(b.lastBootAt).toBeNull();
    expect(b.ramText).toBeNull();
    expect(normalizeEndpoint({ id: 'x' })).toMatchObject({ name: null, missingCriticalUpdates: null, rebootRequired: null, lastSeenAt: null });
    // Undocumented flat count keys are accepted as a fallback.
    expect(normalizeEndpoint({ missing_critical_updates: 4, missing_other_updates: '1' })).toMatchObject({ missingCriticalUpdates: 4, missingOtherUpdates: 1 });
  });

  it('guesses CI types only when reliable', () => {
    const base = { osName: 'Windows 11 (24H2)', manufacturer: 'Contoso Devices', serialNumber: null, name: 'Reception PC', deviceName: 'NS-DESK-021' };
    expect(guessCiTypeName(base)).toBeNull();
    expect(guessCiTypeName({ ...base, osName: 'Windows Server 2022' })).toBe('Server');
    expect(guessCiTypeName({ ...base, manufacturer: 'VMware, Inc.' })).toBe('Virtual Machine');
    expect(guessCiTypeName({ ...base, deviceName: 'NS-LAPTOP-014' })).toBe('Laptop');
    expect(guessCiTypeName({ ...base, deviceName: 'DESKTOP-AB12CD3' })).toBeNull();
  });

  it('matches logged-in users to contacts only when unique', () => {
    const contacts = [
      { id: 1, firstName: 'Emma', lastName: 'Smith', email: 'emma.smith@northstar.example' },
      { id: 2, firstName: 'Emma', lastName: 'Stone', email: 'e.stone@northstar.example' },
      { id: 3, firstName: 'Liam', lastName: 'Brown', email: 'liam.brown@northstar.example' },
      { id: 4, firstName: 'Liam', lastName: 'Brown', email: 'l.brown@northstar.example' },
    ];
    const ids = (u: string) => matchContactCandidates(u, contacts).map((c) => c.id);
    expect(ids('NORTHSTAR\\emma.smith')).toEqual([1]);
    expect(ids('AzureAD\\EmmaSmith')).toEqual([1]);
    expect(ids('emma.smith@northstar.example')).toEqual([1]);
    expect(ids('AzureAD\\LiamBrown')).toEqual([3, 4]);
    expect(ids('NORTHSTAR\\reception')).toEqual([]);
  });
});

/* ======================================================= sync + API tests */

describe('Action1 sync and API', () => {
  let mock: MockAction1;
  let ctx: TestContext;
  let admin: Client & { userId: number };
  let northstar: { id: number };
  let bluepeak: { id: number };
  let emmaId: number;
  const ci: Record<string, number> = {};

  const api = (p: string) => `/api/v1${p}`;
  const getEndpoint = async (externalId: string) => (await ctx.db.select().from(s.action1Endpoints).where(eq(s.action1Endpoints.externalId, externalId)))[0]!;
  const getCi = async (id: number) => (await ctx.db.select().from(s.configurationItems).where(eq(s.configurationItems.id, id)))[0]!;
  const syncInline = async () => {
    const res = await admin.post(api('/integrations/action1/sync?inline=true'));
    expect(res.status).toBe(200);
    return res.body;
  };
  const nonGet = () => mock.requests.filter((r) => r.method !== 'GET');

  async function makeCi(companyId: number, values: Partial<typeof s.configurationItems.$inferInsert> & { name: string }) {
    const [type] = await ctx.db.select().from(s.ciTypes).where(eq(s.ciTypes.name, 'Desktop'));
    const [row] = await ctx.db
      .insert(s.configurationItems)
      .values({ ciNumber: formatNumber('CI-', await nextSequence(ctx.db, 'ci')), ciTypeId: type!.id, companyId, source: 'manual', ...values })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    mock = await startMockAction1();
    ctx = await createTestApp({ ACTION1_BASE_URL_OVERRIDE: `${mock.url}/api/3.0` });
    admin = await userClient(ctx, 'administrator');
    northstar = await makeCompany(admin, 'Northstar Consulting');
    bluepeak = await makeCompany(admin, 'BluePeak Logistics');
    const mk = async (companyId: number, firstName: string, lastName: string, email: string) => {
      const r = await admin.post(api('/contacts'), { companyId, firstName, lastName, email });
      expect(r.status).toBe(201);
      return r.body.id as number;
    };
    emmaId = await mk(northstar.id, 'Emma', 'Smith', 'emma.smith@northstar.example');
    await mk(northstar.id, 'Liam', 'Brown', 'liam.brown@northstar.example');
    await mk(northstar.id, 'Liam', 'Brown', 'l.brown@northstar.example');
    await mk(bluepeak.id, 'Oliver', 'Green', 'oliver.green@bluepeak.example');

    ci.srv = (await makeCi(northstar.id, { name: 'Northstar file server', serialNumber: 'fake-srv-0031' })).id;
    ci.bpShared = (await makeCi(bluepeak.id, { name: 'BluePeak spare laptop', serialNumber: 'FAKE-SHARED-01', hostname: 'BP-SPARE' })).id;
    ci.desk1 = (await makeCi(northstar.id, { name: 'NS-DESK-021' })).id;
    ci.desk2 = (await makeCi(northstar.id, { name: 'Front desk', hostname: 'ns-desk-021' })).id;
    ci.spare = (await makeCi(northstar.id, { name: 'NS spare laptop', serialNumber: 'FAKE-SPARE-77' })).id;
  });

  afterAll(async () => {
    await ctx?.close();
    mock?.server.closeAllConnections();
    await new Promise((r) => mock?.server.close(r));
  });

  it('stores settings with encrypted secrets and never returns them', async () => {
    const initial = await admin.get(api('/integrations/action1'));
    expect(initial.status).toBe(200);
    expect(initial.body.hasCredentials).toBe(false);

    const noCreds = await admin.put(api('/integrations/action1'), { enabled: true, region: 'eu' });
    expect(noCreds.status).toBe(400);

    const res = await admin.put(api('/integrations/action1'), {
      enabled: true,
      region: 'eu',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      syncIntervalMinutes: 60,
      autoCreateCis: true,
      matchBySerial: true,
      matchByHostname: true,
      matchContacts: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, region: 'eu', hasCredentials: true, clientIdHint: `…${CLIENT_ID.slice(-4)}`, matchByHostname: true });
    expect(res.body.nextSyncAt).toBeTruthy();

    for (const url of ['/integrations/action1', '/integrations']) {
      const r = await admin.get(api(url));
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(CLIENT_ID);
      expect(text).not.toContain('secretsEncrypted');
    }
    const [row] = await ctx.db.select().from(s.integrations).where(eq(s.integrations.provider, 'action1'));
    expect(row!.secretsEncrypted).toBeTruthy();
    expect(row!.secretsEncrypted).not.toContain(CLIENT_SECRET);

    // Blank secret on update keeps the stored one.
    const keep = await admin.put(api('/integrations/action1'), { enabled: true, region: 'eu', clientId: '', clientSecret: '', matchByHostname: true });
    expect(keep.status).toBe(200);
    expect(keep.body.hasCredentials).toBe(true);
    const audits = await ctx.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'integration'));
    expect(JSON.stringify(audits)).not.toContain(CLIENT_SECRET);
  });

  it('tests the connection with stored or provided credentials', async () => {
    const ok = await admin.post(api('/integrations/action1/test'));
    expect(ok.body).toEqual({ ok: true, organizations: 2 });
    const bad = await admin.post(api('/integrations/action1/test'), { clientSecret: 'wrong-secret-value-1' });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatch(/credentials/i);
    expect(bad.body.error).not.toContain('wrong-secret-value-1');
  });

  it('upserts organizations without mapping them and creates no CIs for unmapped orgs', async () => {
    const run = await syncInline();
    expect(run.status).toBe('success');
    expect(run.stats.orgs).toBe(2);
    const orgs = await admin.get(api('/integrations/action1/organizations'));
    expect(orgs.body).toHaveLength(2);
    for (const o of orgs.body) expect(o.companyId).toBeNull();
    const eps = await ctx.db.select().from(s.action1Endpoints);
    expect(eps).toHaveLength(5);
    expect(eps.every((e) => e.matchStatus === 'unmapped_org' && e.configurationItemId === null)).toBe(true);
    expect(await ctx.db.select().from(s.configurationItems).where(eq(s.configurationItems.source, 'action1'))).toHaveLength(0);
    // Read-only: the only non-GET request is the token POST.
    expect(nonGet().every((r) => r.method === 'POST' && r.path === '/api/3.0/oauth2/token')).toBe(true);
    // Pagination: Northstar's 4 endpoints arrive in 2 pages of 2.
    expect(mock.requests.filter((r) => r.path === `/api/3.0/endpoints/managed/${ORG_NS}`)).toHaveLength(2);
    expect(mock.requests.find((r) => r.path === `/api/3.0/endpoints/managed/${ORG_NS}`)!.search).toContain('fields=missing_updates');
  });

  it('maps organizations explicitly and validates the company', async () => {
    const orgs = (await admin.get(api('/integrations/action1/organizations'))).body as { id: number; externalId: string }[];
    const ns = orgs.find((o) => o.externalId === ORG_NS)!;
    const bp = orgs.find((o) => o.externalId === ORG_BP)!;
    expect((await admin.patch(api(`/integrations/action1/organizations/${ns.id}`), { companyId: 999999 })).status).toBe(400);
    const r1 = await admin.patch(api(`/integrations/action1/organizations/${ns.id}`), { companyId: northstar.id, enabled: true });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ companyId: northstar.id, companyName: 'Northstar Consulting', warning: null });
    expect((await admin.patch(api(`/integrations/action1/organizations/${bp.id}`), { companyId: bluepeak.id, enabled: true })).status).toBe(200);
  });

  it('matches, creates and flags endpoints within the mapped company only', async () => {
    const tokensBefore = mock.tokensIssued;
    const bpSharedBefore = await getCi(ci.bpShared!);
    const run = await syncInline();
    expect(run.status).toBe('success');
    expect(mock.tokensIssued - tokensBefore).toBe(1); // token cached for the whole run

    // Auto-created laptop CI in Northstar, with contact.
    const laptop = await getEndpoint(EP_LAPTOP);
    expect(laptop.matchStatus).toBe('created');
    const laptopCi = await getCi(laptop.configurationItemId!);
    expect(laptopCi).toMatchObject({
      companyId: northstar.id,
      source: 'action1',
      name: 'NS-LAPTOP-014',
      hostname: 'NS-LAPTOP-014',
      serialNumber: 'FAKE5CD0014',
      osName: 'Windows 11 (24H2)',
      ipAddress: '10.20.30.114',
      macAddress: '3C:52:82:00:00:14',
      lifecycleStatus: 'active',
      contactId: emmaId,
    });
    expect(laptopCi.ciNumber).toMatch(/^CI-\d{6}$/);
    const [laptopType] = await ctx.db.select().from(s.ciTypes).where(eq(s.ciTypes.id, laptopCi.ciTypeId));
    expect(laptopType!.name).toBe('Laptop');
    expect(laptop.contactId).toBe(emmaId);

    // Serial match (case-insensitive) to the manual server CI; name kept, contact ambiguous.
    const srv = await getEndpoint(EP_SRV);
    expect(srv.matchStatus).toBe('matched');
    expect(srv.configurationItemId).toBe(ci.srv);
    expect(srv.contactId).toBeNull();
    expect(srv.contactMatchNote).toMatch(/Ambiguous/);
    const srvCi = await getCi(ci.srv!);
    expect(srvCi).toMatchObject({ name: 'Northstar file server', hostname: 'NS-SRV-01', osName: 'Windows Server 2022', contactId: null });

    // Same serial exists only in BluePeak → never matched across companies; a Northstar CI is created.
    const shared = await getEndpoint(EP_SHARED);
    expect(shared.matchStatus).toBe('created');
    const sharedCi = await getCi(shared.configurationItemId!);
    expect(sharedCi.companyId).toBe(northstar.id);
    expect(sharedCi.id).not.toBe(ci.bpShared);
    expect(sharedCi.contactId).toBe(emmaId); // e-mail form of the logged-in user
    expect(await getCi(ci.bpShared!)).toEqual(bpSharedBefore);

    // Two Northstar CIs share the host name → conflict, nothing created.
    const desk = await getEndpoint(EP_DESK);
    expect(desk.matchStatus).toBe('conflict');
    expect(desk.configurationItemId).toBeNull();
    expect(desk.matchNote).toMatch(/host name/);

    // BluePeak endpoint gets a BluePeak CI; "emma.smith" does not match a Northstar contact.
    const bp = await getEndpoint(EP_BP);
    expect(bp.matchStatus).toBe('created');
    const bpCi = await getCi(bp.configurationItemId!);
    expect(bpCi.companyId).toBe(bluepeak.id);
    expect(bp.contactId).toBeNull();
    expect(bpCi.contactId).toBeNull();

    expect(run.stats).toMatchObject({ created: 3, matched: 1, conflicts: 1, errors: 0 });
    expect(nonGet().every((r) => r.method === 'POST' && r.path === '/api/3.0/oauth2/token')).toBe(true);
  });

  it('is idempotent: a second run creates no duplicates', async () => {
    const cis = (await ctx.db.select().from(s.configurationItems)).length;
    const eps = (await ctx.db.select().from(s.action1Endpoints)).length;
    const run = await syncInline();
    expect(run.status).toBe('success');
    expect(run.stats.created).toBe(0);
    expect((await ctx.db.select().from(s.configurationItems)).length).toBe(cis);
    expect((await ctx.db.select().from(s.action1Endpoints)).length).toBe(eps);
    expect((await getEndpoint(EP_DESK)).matchStatus).toBe('conflict');
  });

  it('renames action1-sourced CIs and records previous names, but keeps manual names', async () => {
    const laptop = mock.endpoints[ORG_NS]!.find((e) => e.id === EP_LAPTOP)!;
    laptop.name = 'NS-LAPTOP-014-EMMA';
    laptop.device_name = 'NS-LAPTOP-014-EMMA';
    const srv = mock.endpoints[ORG_NS]!.find((e) => e.id === EP_SRV)!;
    srv.name = 'NS-SRV-02';
    srv.device_name = 'NS-SRV-02';
    await syncInline();

    const ep = await getEndpoint(EP_LAPTOP);
    expect(ep.previousNames).toEqual(['NS-LAPTOP-014']);
    const laptopCi = await getCi(ep.configurationItemId!);
    expect(laptopCi.name).toBe('NS-LAPTOP-014-EMMA');
    expect(laptopCi.hostname).toBe('NS-LAPTOP-014-EMMA');
    expect((await ctx.db.select().from(s.configurationItems)).filter((c) => c.serialNumber === 'FAKE5CD0014')).toHaveLength(1);

    const srvCi = await getCi(ci.srv!);
    expect(srvCi.name).toBe('Northstar file server');
    expect(srvCi.hostname).toBe('NS-SRV-02');
    expect((await getEndpoint(EP_SRV)).previousNames).toEqual(['NS-SRV-01']);
  });

  it('marks endpoints that disappear as missing without touching their CI', async () => {
    const list = mock.endpoints[ORG_NS]!;
    const removed = list.splice(list.findIndex((e) => e.id === EP_SHARED), 1)[0]!;
    const run = await syncInline();
    expect(run.status).toBe('success');
    expect(run.stats.missing).toBe(1);
    const ep = await getEndpoint(EP_SHARED);
    expect(ep.missingSince).toBeInstanceOf(Date);
    const sharedCi = await getCi(ep.configurationItemId!);
    expect(sharedCi.lifecycleStatus).toBe('active');

    list.push(removed);
    await syncInline();
    expect((await getEndpoint(EP_SHARED)).missingSince).toBeNull();
  });

  it('continues with other organizations when one fails (partial run)', async () => {
    mock.failOrgs.add(ORG_BP);
    const nsBefore = (await ctx.db.select().from(s.action1Organizations).where(eq(s.action1Organizations.externalId, ORG_NS)))[0]!;
    try {
      const client = buildAction1Client(ctx.app.config, 'eu', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, { sleep: async () => {} });
      const run = await runAction1Sync(ctx.db, ctx.app.config, { trigger: 'manual', userId: admin.userId, client });
      expect(run.status).toBe('partial');
      expect(run.stats.errors).toBe(1);
      expect(run.stats.orgsSynced).toBe(1);
      expect(run.log.some((l) => l.level === 'error' && l.message.includes('BluePeak Logistics'))).toBe(true);
      const nsAfter = (await ctx.db.select().from(s.action1Organizations).where(eq(s.action1Organizations.externalId, ORG_NS)))[0]!;
      expect(nsAfter.lastSyncedAt!.getTime()).toBeGreaterThan(nsBefore.lastSyncedAt!.getTime());
      // BluePeak's endpoint is not flagged missing just because its org failed.
      expect((await getEndpoint(EP_BP)).missingSince).toBeNull();
      const [integ] = await ctx.db.select().from(s.integrations).where(eq(s.integrations.provider, 'action1'));
      expect(integ!.status).toBe('error');
      expect(integ!.lastError).toBeTruthy();
      const detail = await admin.get(api(`/integrations/action1/runs/${run.id}`));
      expect(detail.body.log.length).toBeGreaterThan(0);
    } finally {
      mock.failOrgs.clear();
    }
    const runs = await admin.get(api('/integrations/action1/runs?pageSize=2'));
    expect(runs.body.total).toBeGreaterThanOrEqual(6);
    expect(runs.body.data[0].status).toBe('partial');
  });

  it('resolves endpoints through the API: link, cross-company refusal, duplicate link, ignore, unignore', async () => {
    const desk = await getEndpoint(EP_DESK);
    const bp = await getEndpoint(EP_BP);

    const cross = await admin.post(api(`/integrations/action1/endpoints/${desk.id}/resolve`), { action: 'link', configurationItemId: ci.bpShared });
    expect(cross.status).toBe(400);

    const linked = await admin.post(api(`/integrations/action1/endpoints/${desk.id}/resolve`), { action: 'link', configurationItemId: ci.desk1 });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ matchStatus: 'matched', configurationItemId: ci.desk1, companyName: 'Northstar Consulting', ciName: 'NS-DESK-021' });

    const srv = await getEndpoint(EP_SRV);
    const dup = await admin.post(api(`/integrations/action1/endpoints/${srv.id}/resolve`), { action: 'link', configurationItemId: ci.desk1 });
    expect(dup.status).toBe(409);

    // Ignore the BluePeak endpoint: unlinked, and subsequent syncs neither link nor create.
    const bpCiId = bp.configurationItemId!;
    const ign = await admin.post(api(`/integrations/action1/endpoints/${bp.id}/resolve`), { action: 'ignore' });
    expect(ign.status).toBe(200);
    expect(ign.body).toMatchObject({ matchStatus: 'ignored', configurationItemId: null });
    const ciCount = (await ctx.db.select().from(s.configurationItems)).length;
    await syncInline();
    const ignored = await getEndpoint(EP_BP);
    expect(ignored).toMatchObject({ matchStatus: 'ignored', configurationItemId: null });
    expect(ignored.lastSyncedAt.getTime()).toBeGreaterThan(bp.lastSyncedAt.getTime()); // snapshot still updated
    expect((await ctx.db.select().from(s.configurationItems)).length).toBe(ciCount);
    expect(await getCi(bpCiId)).toBeTruthy(); // CI kept

    const un = await admin.post(api(`/integrations/action1/endpoints/${bp.id}/resolve`), { action: 'unignore' });
    expect(un.body.matchStatus).toBe('unmatched');
    await syncInline();
    // Re-matched by serial to the CI created earlier, not duplicated.
    expect(await getEndpoint(EP_BP)).toMatchObject({ matchStatus: 'matched', configurationItemId: bpCiId });

    const audits = await ctx.db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'action1_endpoint'));
    expect(audits.length).toBeGreaterThanOrEqual(3);

    const list = await admin.get(api(`/integrations/action1/endpoints?companyId=${northstar.id}&attention=true`));
    expect(list.status).toBe(200);
    const names = (list.body.data as { name: string }[]).map((d) => d.name).sort();
    expect(names).toEqual(['NS-LAPTOP-014-EMMA', 'Reception PC']); // reboot+critical, disconnected
    const search = await admin.get(api('/integrations/action1/endpoints?q=FAKE-BP'));
    expect(search.body.data).toHaveLength(1);

    const view = await admin.get(api('/integrations/action1'));
    expect(view.body.endpointCounts.total).toBe(5);
    expect(view.body.latestRun.status).toBe('success');
  });

  it('exposes the linked endpoint on the CI and refreshes missing updates on demand', async () => {
    const laptop = await getEndpoint(EP_LAPTOP);
    const res = await admin.get(api(`/configuration-items/${laptop.configurationItemId}/action1`));
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.endpoint).toMatchObject({ externalId: EP_LAPTOP, rebootRequired: true, missingCriticalUpdates: 2 });
    expect(res.body.consoleUrl).toBe(`https://app.eu.action1.com/console/dashboard?org=${ORG_NS}`);
    expect((await admin.get(api(`/configuration-items/${ci.spare}/action1`))).body).toEqual({ linked: false });

    const before = mock.requests.length;
    const upd = await admin.post(api(`/configuration-items/${laptop.configurationItemId}/action1/refresh-updates`));
    expect(upd.status).toBe(200);
    expect(upd.body.count).toBe(2);
    expect((await getEndpoint(EP_LAPTOP)).missingUpdates).toHaveLength(2);
    const made = mock.requests.slice(before);
    expect(made.some((r) => r.path === `/api/3.0/endpoints/managed/${ORG_NS}/${EP_LAPTOP}/missing-updates`)).toBe(true);
    expect(made.every((r) => r.method === 'GET' || r.path === '/api/3.0/oauth2/token')).toBe(true);
  });

  it('queues background syncs with de-duplication', async () => {
    const first = await admin.post(api('/integrations/action1/sync'));
    expect(first.body).toMatchObject({ queued: true });
    const second = await admin.post(api('/integrations/action1/sync'));
    expect(second.body).toMatchObject({ queued: false });
    const jobs = await ctx.db.select().from(s.jobs).where(and(eq(s.jobs.type, 'action1.sync'), eq(s.jobs.status, 'pending')));
    expect(jobs).toHaveLength(1);
    await ctx.db.delete(s.jobs).where(eq(s.jobs.type, 'action1.sync'));
  });

  it('reuses a CI atlas created for the device (MAC match) and takes ownership of it', async () => {
    const vm = await makeCi(northstar.id, { name: 'ns-vm-07', hostname: 'ns-vm-07', source: 'atlas', macAddress: 'bc:24:11:00:00:07' });
    const epId = 'e5a0c3f2-2222-4d7e-8f10-0b0b0b0b0071';
    mock.endpoints[ORG_NS]!.push(endpoint(epId, ORG_NS, { name: 'NS-VM-07', device_name: 'NS-VM-07', MAC: 'BC-24-11-00-00-07', serial: 'VMware-42 00 07' }));
    const cis = (await ctx.db.select().from(s.configurationItems)).length;
    await syncInline();
    const ep = await getEndpoint(epId);
    expect(ep.matchStatus).toBe('matched');
    expect(ep.matchNote).toMatch(/MAC address/);
    expect(ep.configurationItemId).toBe(vm.id);
    expect(await getCi(vm.id)).toMatchObject({ source: 'action1', name: 'NS-VM-07' });
    expect((await ctx.db.select().from(s.configurationItems)).length).toBe(cis);
    mock.endpoints[ORG_NS] = mock.endpoints[ORG_NS]!.filter((e) => e.id !== epId);
  });

  it('records a failed run with a clear error for bad credentials', async () => {
    const put = await admin.put(api('/integrations/action1'), { enabled: true, region: 'eu', clientSecret: 'wrong-secret-value-2', matchByHostname: true });
    expect(put.status).toBe(200);
    expect(put.body.status).toBe('pending');
    const run = await syncInline();
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/credentials/i);
    expect(JSON.stringify(run)).not.toContain('wrong-secret-value-2');
    const view = await admin.get(api('/integrations/action1'));
    expect(view.body.status).toBe('error');
    expect(view.body.lastError).toMatch(/credentials/i);
    // CIs are untouched by a failed run.
    expect((await getEndpoint(EP_LAPTOP)).configurationItemId).toBeTruthy();
  });

  it('records a failed run when the integration is disabled', async () => {
    await admin.put(api('/integrations/action1'), { enabled: false, region: 'eu' });
    const run = await syncInline();
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/disabled/i);
  });
});

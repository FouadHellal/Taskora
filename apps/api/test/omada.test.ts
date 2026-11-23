import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, makeCompany, userClient, type Client, type TestContext } from './helpers.js';
import { schema } from '../src/db/client.js';
import { OmadaClient, type OmadaTransport } from '../src/integrations/omada/client.js';
import { deviceKind, setOmadaClientFactory, uptimeSeconds } from '../src/integrations/omada/sync.js';

let ctx: TestContext;
let admin: Client;
let lookups: any;

/** A fake controller: one site with two APs and a switch, clients on v1 only, token expiring once. */
function fakeController() {
  const calls: string[] = [];
  let tokens = 0;
  let expireOnce = true;
  const ok = (result: unknown) => ({ status: 200, body: { errorCode: 0, msg: 'Success.', result } });
  const transport: OmadaTransport = async (req) => {
    const path = req.url.replace('https://omada.test:8043', '');
    calls.push(`${req.method} ${path.split('?')[0]}`);
    if (path === '/api/info') return ok({ omadacId: 'cid123', controllerVer: '5.15.20', apiVer: '3' });
    if (path.startsWith('/openapi/authorize/token')) {
      const body = JSON.parse(req.body ?? '{}');
      if (body.client_secret !== 'secret') return { status: 200, body: { errorCode: -44106, msg: 'Invalid client credentials.' } };
      tokens++;
      return ok({ accessToken: `tok${tokens}`, expiresIn: 7200, refreshToken: 'r' });
    }
    if (!req.headers.authorization?.startsWith('AccessToken=tok')) return { status: 401, body: { errorCode: -44113, msg: 'Invalid token' } };
    if (path.startsWith('/openapi/v1/cid123/sites?')) {
      if (expireOnce) {
        expireOnce = false;
        return { status: 200, body: { errorCode: -44112, msg: 'The access token has expired.' } };
      }
      return ok({ totalRows: 2, currentPage: 1, data: [{ siteId: 'site-a', name: 'Les Aures - Campus' }, { siteId: 'site-b', name: 'Unmapped' }] });
    }
    if (path.startsWith('/openapi/v1/cid123/sites/site-a/devices'))
      return ok({
        totalRows: 3,
        data: [
          { mac: 'AA-BB-CC-00-00-01', name: 'AP-Hall', type: 'ap', model: 'EAP650', modelName: 'EAP650(EU) v1.0', sn: 'SN001', ip: '10.0.0.11', firmwareVersion: '1.0.5', detailStatus: 14, uptime: '1day(s) 2h 3m 4s', cpuUtil: 7, memUtil: 41, clientNum: 2, lastSeen: 1795000000000, linkSpeed: 3, uplinkDeviceName: 'SW-Core', uplinkDevicePort: '5' },
          { mac: 'AA-BB-CC-00-00-02', name: 'AP-Library', type: 'ap', model: 'EAP245', sn: 'SN002', ip: '10.0.0.12', detailStatus: 0, clientNum: 0 },
          { mac: 'AA-BB-CC-00-00-99', name: 'SW-Core', type: 'switch', model: 'TL-SG3428', sn: 'SN099', ip: '10.0.0.2', detailStatus: 14 },
        ],
      });
    if (path === '/openapi/v1/cid123/clients/stat/devices') return ok([{ mac: 'AA-BB-CC-00-00-01', clientNum: 2, clientNum2g: 1, clientNum5g: 1, clientNum6g: 0 }]);
    if (path.startsWith('/openapi/v2/cid123/sites/site-a/clients')) return { status: 200, body: { errorCode: -1600, msg: 'Unsupported request path.' } };
    if (path.startsWith('/openapi/v1/cid123/sites/site-a/clients'))
      return ok({
        totalRows: 2,
        data: [
          { mac: '11-22-33-44-55-66', name: 'Laptop-Prof', hostName: 'LT-PROF', ip: '10.0.1.50', wireless: true, ssid: 'AURES-STAFF', apMac: 'AA-BB-CC-00-00-01', apName: 'AP-Hall', rssi: -58, signalLevel: 80, channel: 36, wifiMode: 5, trafficDown: 5000000000, trafficUp: 12000, uptime: 3600, active: true },
          { mac: '11-22-33-44-55-77', name: 'Phone-Eleve', wireless: true, ssid: 'AURES-GUEST', apMac: 'AA-BB-CC-00-00-01', rssi: -71, guest: true, active: true },
        ],
      });
    return { status: 404, body: { errorCode: -1, msg: `no fake for ${path}` } };
  };
  return { transport, calls, tokens: () => tokens };
}

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  lookups = (await admin.get('/api/v1/lookups')).body;
});
afterAll(async () => {
  setOmadaClientFactory(null);
  await ctx.close();
});

describe('Omada client', () => {
  it('reads the controller id, authenticates, renews an expired token and falls back to v1 clients', async () => {
    const fake = fakeController();
    const c = new OmadaClient({ baseUrl: 'https://omada.test:8043', clientId: 'id', clientSecret: 'secret', transport: fake.transport, sleep: async () => {} });
    expect((await c.sites()).map((x) => x.siteId)).toEqual(['site-a', 'site-b']);
    expect(fake.tokens()).toBe(2); // renewed after -44112
    expect((await c.clients('site-a')).length).toBe(2);
    expect(fake.calls).toContain('POST /openapi/v2/cid123/sites/site-a/clients');
    expect(fake.calls).toContain('GET /openapi/v1/cid123/sites/site-a/clients');
    const bad = new OmadaClient({ baseUrl: 'https://omada.test:8043', clientId: 'id', clientSecret: 'wrong', transport: fake.transport });
    await expect(bad.sites()).rejects.toThrow(/refused the credentials/);
  });

  it('works with the Omada cloud: no /api/info, the Omada ID is required, errors are explained', async () => {
    const calls: string[] = [];
    const cloud: OmadaTransport = async (req) => {
      calls.push(req.url);
      if (req.url.includes('/openapi/authorize/token')) return { status: 200, body: { errorCode: -7131, msg: 'Controller ID not exist.' } };
      return { status: 200, body: null };
    };
    const noId = new OmadaClient({ baseUrl: 'https://euw1-omada-northbound.tplinkcloud.com', clientId: 'id', clientSecret: 'secret', transport: cloud });
    await expect(noId.testConnection()).rejects.toThrow(/Enter the Omada ID/);
    expect(calls).toEqual([]);
    const wrongId = new OmadaClient({ baseUrl: 'https://euw1-omada-northbound.tplinkcloud.com', omadacId: 'x', clientId: 'id', clientSecret: 'secret', transport: cloud });
    await expect(wrongId.testConnection()).rejects.toThrow(/Interface Access Address/);
    expect(calls.some((u) => u.includes('/api/info'))).toBe(false);
  });

  it('understands device types and uptimes', () => {
    expect(deviceKind({ type: 'ap' })).toBe('ap');
    expect(deviceKind({ type: 'switch' })).toBe('switch');
    expect(deviceKind({ type: 'gateway' })).toBe('gateway');
    expect(deviceKind({ model: 'EAP650' })).toBe('ap');
    expect(uptimeSeconds('4day(s) 17h 26m 57s')).toBe(4 * 86400 + 17 * 3600 + 26 * 60 + 57);
    expect(uptimeSeconds(120)).toBe(120);
  });
});

describe('Omada integration', () => {
  it('maps sites to companies, turns access points into CIs and records their clients', async () => {
    const fake = fakeController();
    setOmadaClientFactory((opts) => new OmadaClient({ ...opts, transport: fake.transport, sleep: async () => {} }));
    const co = await makeCompany(admin, 'Les Aures Omada');
    // An existing CI with the same MAC is reused instead of creating a duplicate.
    const ciType = (name: string) => lookups.ciTypes.find((t: { name: string }) => t.name === name).id;
    const existing = (await admin.post('/api/v1/configuration-items', { name: 'Borne hall', ciTypeId: ciType('Wireless Access Point'), companyId: co.id, macAddress: 'aa:bb:cc:00:00:01' })).body;

    const saved = await admin.put('/api/v1/integrations/omada', { enabled: true, mode: 'direct', baseUrl: 'https://omada.test:8043/', clientId: 'id', clientSecret: 'secret' });
    expect(saved.body).toMatchObject({ enabled: true, baseUrl: 'https://omada.test:8043', hasCredentials: true, clientIdHint: '****', deviceKinds: ['ap'] });
    expect(JSON.stringify(saved.body)).not.toContain('secret');
    expect((await admin.post('/api/v1/integrations/omada/test', {})).body).toMatchObject({ ok: true, controllerVersion: '5.15.20', sites: [{ id: 'site-a' }, { id: 'site-b' }] });

    // First sync: sites appear, nothing mapped yet.
    const first = (await admin.post('/api/v1/integrations/omada/sync?inline=true', {})).body;
    expect(first).toMatchObject({ status: 'success', stats: { sites: 2, mappedSites: 0, devices: 0 } });
    const sites = (await admin.get('/api/v1/integrations/omada/sites')).body;
    const siteA = sites.find((x: { siteId: string }) => x.siteId === 'site-a');
    expect((await admin.patch(`/api/v1/integrations/omada/sites/${siteA.id}`, { companyId: co.id })).body.companyId).toBe(co.id);

    const second = (await admin.post('/api/v1/integrations/omada/sync?inline=true', {})).body;
    expect(second).toMatchObject({ status: 'success', stats: { mappedSites: 1, devices: 2, cisMatched: 1, cisCreated: 1, clients: 2 } });

    const devices = (await admin.get('/api/v1/integrations/omada/devices')).body;
    expect(devices.map((d: { name: string }) => d.name).sort()).toEqual(['AP-Hall', 'AP-Library']); // the switch is not wanted (APs only)
    const hall = devices.find((d: { name: string }) => d.name === 'AP-Hall');
    expect(hall).toMatchObject({ kind: 'ap', status: 'online', statusDetail: 'Connected', clientCount2g: 1, clientCount5g: 1, uptimeSeconds: 93784, linkSpeed: '1 Gbps', configurationItemId: existing.id, activeClients: 2 });

    const [created] = await ctx.db.select().from(schema.configurationItems).where(eq(schema.configurationItems.name, 'AP-Library'));
    expect(created).toMatchObject({ macAddress: 'AA:BB:CC:00:00:02', serialNumber: 'SN002', manufacturer: 'TP-Link', source: 'omada' });
    const [updatedExisting] = await ctx.db.select().from(schema.configurationItems).where(eq(schema.configurationItems.id, existing.id));
    expect(updatedExisting).toMatchObject({ name: 'Borne hall', ipAddress: '10.0.0.11', serialNumber: 'SN001', osVersion: '1.0.5' });

    const panel = (await admin.get(`/api/v1/configuration-items/${existing.id}/omada`)).body;
    expect(panel).toMatchObject({ linked: true, siteName: 'Les Aures - Campus', device: { name: 'AP-Hall', cpuUtil: 7, memUtil: 41 } });
    expect(panel.clients.map((c: { hostName: string | null; name: string }) => c.hostName ?? c.name)).toEqual(expect.arrayContaining(['LT-PROF', 'Phone-Eleve']));
    expect(panel.clients.find((c: { mac: string }) => c.mac === '112233445566')).toMatchObject({ ssid: 'AURES-STAFF', rssi: -58, trafficDown: 5000000000, wireless: true });

    // Switches can be included too; a third sync keeps links and adds the switch.
    await admin.put('/api/v1/integrations/omada', { enabled: true, mode: 'direct', baseUrl: 'https://omada.test:8043', deviceKinds: ['ap', 'switch'] });
    const third = (await admin.post('/api/v1/integrations/omada/sync?inline=true', {})).body;
    expect(third.stats).toMatchObject({ devices: 3, cisCreated: 1, cisMatched: 0 });
    expect((await admin.get('/api/v1/integrations/omada')).body.counts).toMatchObject({ sites: 2, mappedSites: 1, devices: 3, online: 2, clients: 2 });
  });
});

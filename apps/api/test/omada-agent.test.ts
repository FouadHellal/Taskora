import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestApp, makeCompany, userClient, type Client, type TestContext } from './helpers.js';
import { schema } from '../src/db/client.js';

let ctx: TestContext;
let admin: Client;
let taskoraUrl = '';
let omadaUrl = '';
let omada: Server;
const dir = mkdtempSync(join(tmpdir(), 'taskora-omada-agent-'));
const agent = resolve(process.cwd(), 'agents/omada/omada-agent.mjs');

/** A small fake Omada controller over plain HTTP. */
function startFakeOmada(): Promise<string> {
  const ok = (result: unknown) => JSON.stringify({ errorCode: 0, msg: 'Success.', result });
  omada = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      if (url === '/api/info') return res.end(ok({ omadacId: 'cid9', controllerVer: '5.15.24' }));
      if (url.startsWith('/openapi/authorize/token')) {
        const b = JSON.parse(body || '{}');
        return res.end(b.client_secret === 'site-secret' ? ok({ accessToken: 'tok', expiresIn: 7200 }) : JSON.stringify({ errorCode: -44106, msg: 'Invalid client credentials.' }));
      }
      if (req.headers.authorization !== 'AccessToken=tok') return res.end(JSON.stringify({ errorCode: -44113, msg: 'Invalid token' }));
      if (url.startsWith('/openapi/v1/cid9/sites?')) return res.end(ok({ totalRows: 1, data: [{ siteId: 's1', name: 'Les Aures' }] }));
      if (url.startsWith('/openapi/v1/cid9/sites/s1/devices'))
        return res.end(ok({ totalRows: 2, data: [{ mac: '00-11-22-33-44-01', name: 'EAP-Accueil', type: 'ap', model: 'EAP245', sn: 'SNA1', ip: '10.1.1.5', detailStatus: 14, clientNum: 1, secretField: 'not sent' }, { mac: '00-11-22-33-44-09', name: 'Switch', type: 'switch' }] }));
      if (url === '/openapi/v1/cid9/clients/stat/devices') return res.end(ok([{ mac: '00-11-22-33-44-01', clientNum: 1, clientNum2g: 0, clientNum5g: 1 }]));
      if (url.startsWith('/openapi/v2/cid9/sites/s1/clients')) return res.end(ok({ totalRows: 1, data: [{ mac: 'AA-AA-AA-AA-AA-01', hostName: 'PC-Direction', ip: '10.1.1.40', wireless: true, ssid: 'AURES', apMac: '00-11-22-33-44-01', rssi: -55, active: true }] }));
      res.statusCode = 404;
      res.end(JSON.stringify({ errorCode: -1, msg: 'not found' }));
    });
  });
  return new Promise((r) => omada.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(omada.address() as { port: number }).port}`)));
}

function runAgent(flag: string, config: Record<string, unknown>): Promise<{ code: number; out: string }> {
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  return new Promise((r) => execFile(process.execPath, [agent, flag, '--config', file], { timeout: 60_000 }, (err, stdout, stderr) => r({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })));
}

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  taskoraUrl = `http://127.0.0.1:${(ctx.app.server.address() as { port: number }).port}`;
  omadaUrl = await startFakeOmada();
});
afterAll(async () => {
  omada?.close();
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Omada site agent', () => {
  it('serves the agent and its installers publicly', async () => {
    for (const f of ['omada-agent.mjs', 'install-windows.ps1', 'install-linux.sh']) {
      const r = await ctx.app.inject({ method: 'GET', url: `/api/v1/integrations/omada/agent/files/${f}` });
      expect(r.statusCode).toBe(200);
      expect(r.body.length).toBeGreaterThan(1000);
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/omada/agent/files/..%2F..%2Fpackage.json' })).statusCode).toBe(404);
  });

  it('pushes sites, devices and clients from the site to Taskora', async () => {
    const co = await makeCompany(admin, 'Agent School');
    const { body: tok } = await admin.post('/api/v1/integrations/omada/agent/token', {});
    expect(tok.token).toMatch(/^tki_/);
    await admin.put('/api/v1/integrations/omada', { enabled: true, mode: 'agent' });
    const config = { taskoraUrl, token: tok.token, omadaUrl, omadaClientId: 'site-id', omadaClientSecret: 'site-secret' };

    // The test checks both sides.
    const test = await runAgent('--test', config);
    expect(test.out).toContain('Omada credentials accepted: 1 site(s): Les Aures');
    expect(test.out).toContain('token accepted');
    expect(test.code).toBe(0);
    const bad = await runAgent('--test', { ...config, omadaClientSecret: 'wrong', token: 'tki_' + 'x'.repeat(40) });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('Omada refused the credentials');
    expect(bad.out).toContain('Taskora refused the agent token');

    // First run: the site appears; nothing mapped yet.
    await runAgent('--once', config);
    const sites = (await admin.get('/api/v1/integrations/omada/sites')).body;
    expect(sites.map((x: { name: string }) => x.name)).toEqual(['Les Aures']);
    await admin.patch(`/api/v1/integrations/omada/sites/${sites[0].id}`, { companyId: co.id });

    // Second run: devices and clients arrive, the AP becomes a CI.
    const second = await runAgent('--once', config);
    expect(second.out).toContain('1 device(s), 1 client(s)');
    const devices = (await admin.get('/api/v1/integrations/omada/devices')).body;
    expect(devices).toHaveLength(1); // APs only
    expect(devices[0]).toMatchObject({ name: 'EAP-Accueil', status: 'online', companyName: 'Agent School', activeClients: 1, clientCount5g: 1 });
    expect(devices[0].configurationItemId).toBeTruthy();
    const [dev] = await ctx.db.select().from(schema.omadaDevices).where(eq(schema.omadaDevices.mac, '001122334401'));
    expect(dev!.raw).not.toHaveProperty('secretField'); // the agent only sends the fields Taskora uses
    const view = (await admin.get('/api/v1/integrations/omada')).body;
    expect(view).toMatchObject({ mode: 'agent', status: 'connected', agent: { version: '1.0.0', controllerVersion: '5.15.24', lastError: null } });
    expect(view.agentTokens).toHaveLength(1);
    expect(view.latestRun).toMatchObject({ trigger: 'agent', status: 'success' });

    // An Omada failure on site is reported and shown in Taskora.
    await runAgent('--once', { ...config, omadaClientSecret: 'wrong' });
    const failed = (await admin.get('/api/v1/integrations/omada')).body;
    expect(failed.status).toBe('error');
    expect(failed.agent.lastError).toContain('Omada refused the credentials');

    // A revoked token is refused.
    await admin.delete(`/api/v1/integrations/tokens/${tok.id}`);
    const revoked = await runAgent('--test', config);
    expect(revoked.out).toContain('Taskora refused the agent token');
  }, 120_000);
});

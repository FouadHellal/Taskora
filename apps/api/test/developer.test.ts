import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createTestApp, makeCompany, userClient, type Client, type TestContext } from './helpers.js';
import { claimJob, completeJob } from '../src/jobs/queue.js';
import { deliverWebhook } from '../src/lib/webhooks.js';
import { loadConfig } from '../src/config.js';

let ctx: TestContext;
let admin: Client;
let tech: Client;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  tech = await userClient(ctx, 'technician');
});
afterAll(async () => ctx.close());

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('API keys', () => {
  it('lets automation call the API as the key owner without CSRF, until revoked', async () => {
    const created = await tech.post('/api/v1/api-keys', { name: 'n8n' });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    expect(token).toMatch(/^tka_/);
    expect(created.body.tokenHash).toBeUndefined();

    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.roleKey).toBe('technician');

    const co = await makeCompany(admin, 'API Co');
    const ticket = await ctx.app.inject({ method: 'POST', url: '/api/v1/tickets', headers: bearer(token), payload: { title: 'From n8n', companyId: co.id } });
    expect(ticket.statusCode).toBe(201);
    // The owner's permissions still apply (technicians cannot manage users).
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(token) })).statusCode).toBe(403);

    const list = await tech.get('/api/v1/api-keys');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].lastUsedAt).toBeTruthy();

    expect((await tech.delete(`/api/v1/api-keys/${created.body.id}`)).status).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(token) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer('tka_' + 'x'.repeat(40)) })).statusCode).toBe(401);
  });
});

describe('webhooks', () => {
  let server: Server;
  const received: { headers: Record<string, unknown>; body: string }[] = [];
  let url = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function drain() {
    const config = loadConfig({ NODE_ENV: 'test', UPLOAD_DIR: './.data/test-uploads' });
    for (;;) {
      const job = await claimJob(ctx.db, 'test');
      if (!job) break;
      if (job.type === 'webhook.deliver') await deliverWebhook(ctx.db, { ...config, encryptionKey: (ctx.app as any).config.encryptionKey }, job.payload);
      await completeJob(ctx.db, job.id);
    }
  }

  it('signs and delivers subscribed events only', async () => {
    expect((await tech.get('/api/v1/webhooks')).status).toBe(403);
    const hook = await admin.post('/api/v1/webhooks', { name: 'n8n', url, events: ['ticket.created', 'ticket.note_added'] });
    expect(hook.status).toBe(201);
    const secret = hook.body.secret as string;
    expect(secret).toMatch(/^whsec_/);

    const co = await makeCompany(admin, 'Hook Co'); // company.created is not subscribed
    const t = await admin.post('/api/v1/tickets', { title: 'Webhook me', companyId: co.id });
    await admin.post(`/api/v1/tickets/${t.body.id}/notes`, { body: 'A note', visibility: 'internal' });
    await drain();

    const events = received.map((r) => JSON.parse(r.body));
    expect(events.map((e) => e.event).sort()).toEqual(['ticket.created', 'ticket.note_added']);
    const created = events.find((e) => e.event === 'ticket.created');
    expect(created.data.ticket.title).toBe('Webhook me');
    expect(created.data.ticket.companyName).toBe('Hook Co');
    const r = received[0]!;
    expect(r.headers['x-taskora-signature']).toBe(`sha256=${createHmac('sha256', secret).update(r.body).digest('hex')}`);

    const after = (await admin.get('/api/v1/webhooks')).body.data[0];
    expect(after.lastStatus).toBe(204);
    expect(after.signed).toBe(true);
    expect(after.secretEncrypted).toBeUndefined();
  });
});

describe('inbound e-mail settings and endpoint', () => {
  it('stores the mailbox without ever returning the password', async () => {
    const saved = await admin.put('/api/v1/settings/imap', { enabled: true, host: 'imap.example.test', port: 993, secure: true, user: 'support@example.test', password: 's3cret', mailbox: 'INBOX' });
    expect(saved.status).toBe(200);
    expect(saved.body.hasPassword).toBe(true);
    expect(saved.body.active).toBe('settings');
    expect(JSON.stringify(saved.body)).not.toContain('s3cret');
    const kept = await admin.put('/api/v1/settings/imap', { enabled: false, host: 'imap.example.test', port: 993, secure: true, user: 'support@example.test', mailbox: 'INBOX' });
    expect(kept.body.hasPassword).toBe(true);
    expect(kept.body.active).toBe(null);
  });

  it('turns a posted e-mail into a ticket and is idempotent', async () => {
    const co = await makeCompany(admin, 'Mail Co');
    await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Lia', lastName: 'Ng', email: 'lia@mail.example' });
    const body = { from: 'lia@mail.example', subject: 'Laptop broken', text: 'Screen is black', messageId: '<abc@mail>' };
    const first = await admin.post('/api/v1/inbound/email', body);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('created');
    const t = await admin.get(`/api/v1/tickets/${first.body.ticketId}`);
    expect(t.body.companyId).toBe(co.id);
    expect((await admin.post('/api/v1/inbound/email', body)).body.status).toBe('duplicate');
  });
});

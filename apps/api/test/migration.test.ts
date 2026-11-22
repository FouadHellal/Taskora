import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestApp, makeCompany, userClient, Client, type TestContext } from './helpers.js';
import { schema as s } from '../src/db/client.js';
import { resolveSmtp } from '../src/lib/mail.js';
import { resolveImap } from '../src/lib/imap-settings.js';
import { decryptJson } from '../src/lib/crypto.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const dir = (n: string) => mkdtempSync(join(tmpdir(), `taskora-mig-${n}-`));
const dirs = { aUp: dir('a-up'), aBk: dir('a-bk'), bUp: dir('b-up'), bBk: dir('b-bk') };

let A: TestContext;
let B: TestContext;
let adminA: Client & { userId: number };
let adminB: Client;

function multipart(fields: Record<string, string>, fileName: string, content: Buffer, contentType = 'application/gzip') {
  const boundary = '----taskora-mig-boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function post(ctx: TestContext, c: Client, url: string, m: { body: Buffer; contentType: string }) {
  const res = await ctx.app.inject({ method: 'POST', url, payload: m.body, headers: { 'content-type': m.contentType, cookie: c.cookie, 'x-csrf-token': c.csrf } });
  return { status: res.statusCode, body: res.json() as any };
}

const importInto = (ctx: TestContext, c: Client, passphrase: string, file: Buffer) =>
  post(ctx, c, '/api/v1/admin/migration/import?confirm=RESTORE', multipart({ passphrase }, 'pkg.json.gz', file));

beforeAll(async () => {
  A = await createTestApp({ TASKORA_ENCRYPTION_KEY: KEY_A, UPLOAD_DIR: dirs.aUp, BACKUP_DIR: dirs.aBk });
  B = await createTestApp({ TASKORA_ENCRYPTION_KEY: KEY_B, UPLOAD_DIR: dirs.bUp, BACKUP_DIR: dirs.bBk });
  adminA = await userClient(A, 'administrator');
  adminB = await userClient(B, 'administrator');
});
afterAll(async () => {
  await A.close();
  await B.close();
  for (const d of Object.values(dirs)) rmSync(d, { recursive: true, force: true });
});

describe('moving Taskora to another server', () => {
  it('moves data, files and stored secrets to a server with a different encryption key', async () => {
    // Source server: data, an attachment and every kind of stored secret.
    const co = await makeCompany(adminA, 'Moving Co');
    const t = await adminA.post('/api/v1/tickets', { title: 'Comes along', companyId: co.id });
    const att = await post(A, adminA, `/api/v1/attachments/ticket/${t.body.id}`, multipart({}, 'note.txt', Buffer.from('hello from the old server'), 'text/plain'));
    expect(att.status).toBe(201);
    const attId = att.body.data[0].id;
    expect(
      (await adminA.put('/api/v1/settings/email', { enabled: true, host: 'smtp.example.test', port: 587, secure: false, user: 'mailer', password: 'smtp-secret-1', from: 'help@example.test' }))
        .status,
    ).toBe(200);
    expect((await adminA.put('/api/v1/settings/imap', { enabled: true, host: 'imap.example.test', port: 993, secure: true, user: 'help@example.test', password: 'imap-secret-1', mailbox: 'INBOX' })).status).toBe(200);
    expect((await adminA.post('/api/v1/webhooks', { name: 'n8n', url: 'https://n8n.example.test/hook', events: ['ticket.created'], secret: 'whsec_original' })).status).toBe(201);
    const key = await adminA.post('/api/v1/api-keys', { name: 'n8n' });

    expect((await adminA.post('/api/v1/admin/migration/export', { passphrase: 'short' })).status).toBe(400);
    const exp = await A.app.inject({
      method: 'POST',
      url: '/api/v1/admin/migration/export',
      payload: { passphrase: 'correct horse battery' },
      headers: { cookie: adminA.cookie, 'x-csrf-token': adminA.csrf },
    });
    expect(exp.statusCode).toBe(200);
    expect(String(exp.headers['content-disposition'])).toMatch(/taskora-migration-\d{8}-\d{6}\.json\.gz/);
    const pkg = exp.rawPayload;

    // A normal restore refuses a migration package; a wrong passphrase changes nothing.
    const asBackup = await post(B, adminB, '/api/v1/admin/backups/restore?confirm=RESTORE&safetyBackup=false', multipart({}, 'pkg.json.gz', pkg));
    expect(asBackup.status).toBe(400);
    expect(asBackup.body.error.message).toContain('migration package');
    expect((await importInto(B, adminB, 'not the passphrase', pkg)).status).toBe(400);
    expect((await adminB.get('/api/v1/companies?q=Moving')).body.total).toBe(0);

    // Import on the new server.
    const ok = await importInto(B, adminB, 'correct horse battery', pkg);
    expect(ok.status).toBe(200);
    expect(ok.body.files).toBeGreaterThanOrEqual(1);
    expect(ok.body.safetyBackup).toMatch(/pre-restore/);
    expect(ok.body.skippedSecrets).toEqual([]);

    // Everyone is signed out; the old server's admin signs in with the old password.
    expect((await adminB.get('/api/v1/auth/me')).status).toBe(401);
    const [old] = await A.db.select({ email: s.users.email }).from(s.users).where(eq(s.users.id, adminA.userId));
    const moved = new Client(B.app);
    await moved.login(old!.email, 'Correct-Horse-42');

    expect((await moved.get(`/api/v1/tickets/${t.body.id}`)).body.title).toBe('Comes along');
    const file = await moved.get(`/api/v1/attachments/file/${attId}`);
    expect(file.status).toBe(200);
    expect(String(file.body)).toContain('hello from the old server');

    // Stored secrets are readable with the NEW server's key.
    const cfgB = (B.app as any).config;
    expect((await resolveSmtp(B.db, cfgB))?.password).toBe('smtp-secret-1');
    expect((await resolveImap(B.db, cfgB))?.password).toBe('imap-secret-1');
    const [wh] = await B.db.select().from(s.webhooks);
    expect(decryptJson<string>(cfgB.encryptionKey, wh!.secretEncrypted!)).toBe('whsec_original');

    // API keys keep working.
    const viaKey = await B.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${key.body.token}` } });
    expect(viaKey.statusCode).toBe(200);
  });

  it('saves a package on the server and imports it from the list', async () => {
    const saved = await adminA.post('/api/v1/admin/migration/export', { passphrase: 'another long phrase', save: true });
    expect(saved.status).toBe(201);
    expect(saved.body.name).toMatch(/^taskora-migration-/);
    const list = await adminA.get('/api/v1/admin/backups');
    expect(list.body.data.find((b: { name: string }) => b.name === saved.body.name)?.kind).toBe('migration');
    expect((await adminA.post(`/api/v1/admin/migration/import/${saved.body.name}`, { passphrase: 'wrong wrong wrong', confirm: 'RESTORE' })).status).toBe(400);
    const good = await adminA.post(`/api/v1/admin/migration/import/${saved.body.name}`, { passphrase: 'another long phrase', confirm: 'RESTORE', safetyBackup: false });
    expect(good.status).toBe(200);
  });
});

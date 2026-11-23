import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, createTestApp, makeCompany, userClient, type TestContext } from './helpers.js';
import { createPortalResetToken } from '../src/modules/portal/routes.js';

let ctx: TestContext;
let admin: Client;

const uploads = mkdtempSync(join(tmpdir(), 'taskora-portal-uploads-'));

beforeAll(async () => {
  ctx = await createTestApp({ UPLOAD_DIR: uploads });
  admin = await userClient(ctx, 'administrator');
});
afterAll(async () => {
  await ctx.close();
  rmSync(uploads, { recursive: true, force: true });
});

async function uploadTo(c: Client, url: string, name: string, content: string) {
  const boundary = '----taskora-portal-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await ctx.app.inject({ method: 'POST', url, payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: c.cookie, 'x-csrf-token': c.csrf } });
  return { status: res.statusCode, body: res.json() as any };
}

/** A company with two contacts that have portal access: Mia (manager) and Noah (user). */
async function clientCompany(name: string) {
  const co = await makeCompany(admin, name);
  const slug = name.toLowerCase().replace(/[^a-z]/g, '');
  const mia = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Mia', lastName: 'Manager', email: `mia@${slug}.example` })).body;
  const noah = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Noah', lastName: 'User', email: `noah@${slug}.example` })).body;
  const miaPw = (await admin.post(`/api/v1/contacts/${mia.id}/portal`, { enabled: true, role: 'manager' })).body.password;
  const noahPw = (await admin.post(`/api/v1/contacts/${noah.id}/portal`, { enabled: true })).body.password;
  return { co, mia, noah, miaPortal: await portalLogin(mia.email, miaPw), noahPortal: await portalLogin(noah.email, noahPw) };
}

async function portalLogin(email: string, password: string) {
  const c = new Client(ctx.app);
  const res = await c.post('/api/portal/login', { email, password });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  c.csrf = res.body.csrfToken;
  return c;
}

describe('customer portal', () => {
  it('lets a contact see only their tickets and customer-visible notes', async () => {
    const co = await makeCompany(admin, 'Portal Co');
    const emma = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Emma', lastName: 'Smith', email: 'emma@portal.example' })).body;
    const liam = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Liam', lastName: 'Brown', email: 'liam@portal.example' })).body;
    expect(emma.portalPasswordHash).toBeUndefined();

    const access = await admin.post(`/api/v1/contacts/${emma.id}/portal`, { enabled: true });
    expect(access.body.password).toBeTruthy();
    const portal = await portalLogin('emma@portal.example', access.body.password);
    expect((await portal.get('/api/portal/me')).body.contact.companyName).toBe('Portal Co');

    const mine = (await admin.post('/api/v1/tickets', { title: 'Emma printer', companyId: co.id, contactId: emma.id })).body;
    const other = (await admin.post('/api/v1/tickets', { title: 'Liam laptop', companyId: co.id, contactId: liam.id })).body;
    await admin.post(`/api/v1/tickets/${mine.id}/notes`, { body: 'Internal: printer is ancient', visibility: 'internal' });
    await admin.post(`/api/v1/tickets/${mine.id}/notes`, { body: 'We ordered a new toner.', visibility: 'public' });

    const list = await portal.get('/api/portal/tickets');
    expect(list.body.data.map((t: { id: number }) => t.id)).toEqual([mine.id]);
    expect((await portal.get(`/api/portal/tickets/${other.id}`)).status).toBe(404);
    const detail = (await portal.get(`/api/portal/tickets/${mine.id}`)).body;
    expect(detail.notes.map((n: { body: string }) => n.body)).toEqual(['We ordered a new toner.']);
    expect(JSON.stringify(detail)).not.toContain('ancient');

    // Portal cookie grants nothing on the staff API, and CSRF is enforced.
    expect((await portal.get('/api/v1/companies')).status).toBe(401);
    const csrf = portal.csrf;
    portal.csrf = '';
    expect((await portal.post('/api/portal/tickets', { title: 'No CSRF here' })).status).toBe(403);
    portal.csrf = csrf;

    const created = await portal.post('/api/portal/tickets', { title: 'Need a new mouse', description: 'Scroll wheel broken' });
    expect(created.status).toBe(201);
    const staffView = (await admin.get(`/api/v1/tickets/${created.body.id}`)).body;
    expect(staffView).toMatchObject({ contactId: emma.id, companyId: co.id, sourceName: 'Portal' });

    expect((await portal.post(`/api/portal/tickets/${mine.id}/replies`, { body: 'Thanks!' })).status).toBe(201);
    expect((await portal.post(`/api/portal/tickets/${other.id}/replies`, { body: 'sneaky' })).status).toBe(404);

    // Disabling access ends the session.
    await admin.post(`/api/v1/contacts/${emma.id}/portal`, { enabled: false });
    expect((await portal.get('/api/portal/tickets')).status).toBe(401);
  });

  it('resets a forgotten password with a one-time token', async () => {
    const co = await makeCompany(admin, 'Reset Co');
    const c = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Rita', lastName: 'R', email: 'rita@reset.example' })).body;
    await admin.post(`/api/v1/contacts/${c.id}/portal`, { enabled: true });
    expect((await new Client(ctx.app).post('/api/portal/forgot-password', { email: 'nobody@reset.example' })).body).toEqual({ ok: true });
    const token = await createPortalResetToken(ctx.db, c.id);
    expect((await new Client(ctx.app).post('/api/portal/reset-password', { token: 'x'.repeat(30), password: 'Brand-new-pass-1' })).status).toBe(400);
    expect((await new Client(ctx.app).post('/api/portal/reset-password', { token, password: 'Brand-new-pass-1' })).status).toBe(200);
    expect((await new Client(ctx.app).post('/api/portal/reset-password', { token, password: 'Another-pass-22' })).status).toBe(400);
    await portalLogin('rita@reset.example', 'Brand-new-pass-1');
  });

  it('rejects wrong passwords and contacts without access', async () => {
    const res = await new Client(ctx.app).post('/api/portal/login', { email: 'liam@portal.example', password: 'whatever-123' });
    expect(res.status).toBe(401);
  });

  it('shows only public, published knowledge-base articles', async () => {
    const co = await makeCompany(admin, 'KB Portal Co');
    const c = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Ana', lastName: 'T', email: 'ana@kbportal.example' })).body;
    const pw = (await admin.post(`/api/v1/contacts/${c.id}/portal`, { enabled: true })).body.password;
    await admin.post('/api/v1/kb/articles', { title: 'How to reset your password', body: 'Use the self-service page.', visibility: 'public', status: 'published' });
    await admin.post('/api/v1/kb/articles', { title: 'Internal runbook', body: 'secret', visibility: 'internal', status: 'published' });
    const portal = await portalLogin('ana@kbportal.example', pw);
    const titles = (await portal.get('/api/portal/kb')).body.data.map((a: { title: string }) => a.title);
    expect(titles).toContain('How to reset your password');
    expect(titles).not.toContain('Internal runbook');
  });
});

describe('client portal', () => {
  it('lets a portal manager see the whole company and a user only their own tickets', async () => {
    const { co, mia, noah, miaPortal, noahPortal } = await clientCompany('Role Co');
    const t1 = (await admin.post('/api/v1/tickets', { title: 'Mia VPN', companyId: co.id, contactId: mia.id })).body;
    const t2 = (await admin.post('/api/v1/tickets', { title: 'Noah printer', companyId: co.id, contactId: noah.id })).body;
    const ids = (c: Client) => c.get('/api/portal/tickets?state=all').then((r) => r.body.data.map((t: { id: number }) => t.id).sort());
    expect(await ids(miaPortal)).toEqual([t1.id, t2.id].sort());
    expect(await ids(noahPortal)).toEqual([t2.id]);
    expect((await miaPortal.get('/api/portal/me')).body.contact.isManager).toBe(true);
    expect((await noahPortal.get('/api/portal/me')).body.contact.isManager).toBe(false);
    expect((await noahPortal.get(`/api/portal/tickets/${t1.id}`)).status).toBe(404);
    const search = await miaPortal.get('/api/portal/tickets?state=all&q=printer');
    expect(search.body.data.map((t: { id: number }) => t.id)).toEqual([t2.id]);
    const dash = (await miaPortal.get('/api/portal/dashboard')).body;
    expect(dash.counts.total).toBe(2);
    expect(dash.recent).toHaveLength(2);
  });

  it('shows the work done on tickets without internal notes or rates', async () => {
    const { co, mia, miaPortal, noahPortal } = await clientCompany('Work Co');
    const t = (await admin.post('/api/v1/tickets', { title: 'Server slow', companyId: co.id, contactId: mia.id })).body;
    const te = await admin.post('/api/v1/time-entries', {
      ticketId: t.id,
      startedAt: new Date(Date.now() - 3600_000).toISOString(),
      durationMinutes: 45,
      description: 'Cleaned up the disk',
      internalNotes: 'customer keeps filling it with videos',
    });
    expect(te.status).toBe(201);
    const detail = (await miaPortal.get(`/api/portal/tickets/${t.id}`)).body;
    expect(detail.workedMinutes).toBe(45);
    expect(detail.timeEntries[0]).toMatchObject({ minutes: 45, description: 'Cleaned up the disk' });
    expect(JSON.stringify(detail)).not.toContain('videos');
    expect(JSON.stringify(detail)).not.toContain('hourlyRate');
    const work = (await miaPortal.get('/api/portal/work')).body;
    expect(work.entries.map((e: { ticketId: number }) => e.ticketId)).toContain(t.id);
    expect(work.months.reduce((a: number, m: { minutes: number }) => a + m.minutes, 0)).toBe(45);
    expect(Array.isArray(work.contracts)).toBe(true);
    // Noah's work list does not include Mia's ticket.
    expect((await noahPortal.get('/api/portal/work')).body.entries).toHaveLength(0);

    await admin.put('/api/v1/settings/system', { portalShowTime: false });
    expect((await miaPortal.get('/api/portal/work')).status).toBe(403);
    expect((await miaPortal.get(`/api/portal/tickets/${t.id}`)).body.timeEntries).toEqual([]);
    await admin.put('/api/v1/settings/system', { portalShowTime: true });
  });

  it('lets clients write their company documentation; IT pages stay read-only', async () => {
    const { co, miaPortal, noahPortal } = await clientCompany('Docs Co');
    const other = await clientCompany('Other Docs Co');
    const staffPublic = (await admin.post('/api/v1/kb/articles', { title: 'Your Wi-Fi setup', body: 'SSID office', companyId: co.id, visibility: 'public', status: 'published' })).body;
    await admin.post('/api/v1/kb/articles', { title: 'Firewall admin notes', body: 'internal', companyId: co.id, visibility: 'internal', status: 'published' });

    const created = await noahPortal.post('/api/portal/docs', { title: 'Office opening hours', body: 'Mon-Fri 8-18' });
    expect(created.status).toBe(201);
    const titles = (c: Client) => c.get('/api/portal/docs').then((r) => r.body.data.map((d: { title: string }) => d.title));
    expect(await titles(miaPortal)).toEqual(['Office opening hours', 'Your Wi-Fi setup']);
    expect(await titles(other.miaPortal)).toEqual([]);
    expect((await other.miaPortal.get(`/api/portal/docs/${created.body.id}`)).status).toBe(404);

    // A colleague can edit a client page; IT pages cannot be edited or deleted.
    expect((await miaPortal.patch(`/api/portal/docs/${created.body.id}`, { body: 'Mon-Fri 8-17' })).status).toBe(200);
    expect((await miaPortal.get(`/api/portal/docs/${created.body.id}`)).body).toMatchObject({ body: 'Mon-Fri 8-17', canEdit: true, byClient: true, updatedByName: 'Mia Manager' });
    expect((await miaPortal.patch(`/api/portal/docs/${staffPublic.id}`, { body: 'hacked' })).status).toBe(403);
    expect((await miaPortal.delete(`/api/portal/docs/${staffPublic.id}`)).status).toBe(403);

    // The IT team sees the page in the company documentation.
    const staff = (await admin.get(`/api/v1/kb/articles?scope=docs&companyId=${co.id}`)).body.data.map((d: { title: string }) => d.title);
    expect(staff).toContain('Office opening hours');

    expect((await miaPortal.delete(`/api/portal/docs/${created.body.id}`)).status).toBe(200);
    await admin.put('/api/v1/settings/system', { portalAllowDocs: false });
    expect((await miaPortal.get('/api/portal/docs')).status).toBe(403);
    await admin.put('/api/v1/settings/system', { portalAllowDocs: true });
  });

  it('shares files both ways only when meant for the client', async () => {
    const { co, mia, miaPortal, noahPortal } = await clientCompany('Files Co');
    const t = (await admin.post('/api/v1/tickets', { title: 'Scanner', companyId: co.id, contactId: mia.id })).body;
    const up = await uploadTo(miaPortal, `/api/portal/tickets/${t.id}/files`, 'error.txt', 'scanner error 42');
    expect(up.status).toBe(201);
    expect((await uploadTo(miaPortal, `/api/portal/tickets/${t.id}/files`, 'evil.exe', 'MZ')).status).toBe(400);
    expect((await uploadTo(noahPortal, `/api/portal/tickets/${t.id}/files`, 'x.txt', 'x')).status).toBe(404);

    const staffFile = (await uploadTo(admin, `/api/v1/attachments/ticket/${t.id}`, 'internal-log.txt', 'secret log')).body.data[0];
    const staffList = (await admin.get(`/api/v1/attachments/ticket/${t.id}`)).body.data;
    expect(staffList.find((f: { fileName: string }) => f.fileName === 'error.txt')).toMatchObject({ portalVisible: true, uploadedBy: 'Mia Manager (client)' });

    let files = (await miaPortal.get(`/api/portal/tickets/${t.id}`)).body.files;
    expect(files.map((f: { fileName: string }) => f.fileName)).toEqual(['error.txt']);
    expect((await miaPortal.get(`/api/portal/tickets/${t.id}/files/${staffFile.id}`)).status).toBe(404);
    const dl = await miaPortal.get(`/api/portal/tickets/${t.id}/files/${up.body.data[0].id}`);
    expect(dl.status).toBe(200);
    expect(String(dl.body)).toContain('scanner error 42');

    expect((await admin.patch(`/api/v1/attachments/file/${staffFile.id}/portal`, { portalVisible: true })).status).toBe(200);
    files = (await miaPortal.get(`/api/portal/tickets/${t.id}`)).body.files;
    expect(files.map((f: { fileName: string }) => f.fileName).sort()).toEqual(['error.txt', 'internal-log.txt']);
    expect((await admin.patch(`/api/v1/attachments/file/${up.body.data[0].id}/portal`, { portalVisible: false })).status).toBe(400);
  });

  it('creates requests with a priority and one of the company devices', async () => {
    const { co, mia, miaPortal } = await clientCompany('Device Co');
    const ciTypes = (await admin.get('/api/v1/lookups')).body.ciTypes;
    const ci = (await admin.post('/api/v1/configuration-items', { name: 'MIA-LAPTOP', companyId: co.id, ciTypeId: ciTypes[0].id, contactId: mia.id })).body;
    const otherCo = await makeCompany(admin, 'Not Mine Co');
    const foreign = (await admin.post('/api/v1/configuration-items', { name: 'FOREIGN-PC', companyId: otherCo.id, ciTypeId: ciTypes[0].id })).body;
    const opts = (await miaPortal.get('/api/portal/options')).body;
    expect(opts.devices.map((d: { name: string }) => d.name)).toEqual(['MIA-LAPTOP']);
    const high = opts.priorities.at(-1);
    const created = await miaPortal.post('/api/portal/tickets', { title: 'Laptop will not boot', priorityId: high.id, configurationItemId: ci.id });
    expect(created.status).toBe(201);
    const staffView = (await admin.get(`/api/v1/tickets/${created.body.id}`)).body;
    expect(staffView).toMatchObject({ priorityId: high.id, configurationItemId: ci.id });
    expect((await miaPortal.post('/api/portal/tickets', { title: 'Not my device', configurationItemId: foreign.id })).status).toBe(400);
    expect((await miaPortal.get('/api/portal/devices')).body.data[0]).toMatchObject({ name: 'MIA-LAPTOP', mine: true });
  });

  it('changes the password and can be switched off', async () => {
    const { mia } = await clientCompany('Profile Co');
    const access = await admin.post(`/api/v1/contacts/${mia.id}/portal`, { enabled: true, resetPassword: true });
    const fresh = await portalLogin(mia.email, access.body.password);
    expect((await fresh.post('/api/portal/profile/password', { currentPassword: 'wrong-one-123', newPassword: 'A-brand-new-pass-1' })).status).toBe(400);
    expect((await fresh.post('/api/portal/profile/password', { currentPassword: access.body.password, newPassword: 'A-brand-new-pass-1' })).status).toBe(200);
    await portalLogin(mia.email, 'A-brand-new-pass-1');
    expect((await admin.get('/api/v1/portal/users')).body.data.some((u: { email: string }) => u.email === mia.email)).toBe(true);

    await admin.put('/api/v1/settings/system', { portalEnabled: false });
    expect((await fresh.get('/api/portal/tickets')).status).toBe(403);
    expect((await new Client(ctx.app).post('/api/portal/login', { email: mia.email, password: 'A-brand-new-pass-1' })).status).toBe(403);
    expect((await new Client(ctx.app).get('/api/portal/info')).body).toMatchObject({ enabled: false });
    await admin.put('/api/v1/settings/system', { portalEnabled: true });
  });
});

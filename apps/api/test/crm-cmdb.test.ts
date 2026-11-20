import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeCompany, makeContact, userClient, type Client, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: Client;
let lookups: any;
const ciType = (name: string) => lookups.ciTypes.find((t: { name: string }) => t.name === name).id;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  lookups = (await admin.get('/api/v1/lookups')).body;
});
afterAll(async () => ctx.close());

describe('companies', () => {
  it('creates, reads, updates and lists companies with validation', async () => {
    expect((await admin.post('/api/v1/companies', { name: '' })).status).toBe(400);
    expect((await admin.post('/api/v1/companies', { name: 'Bad', email: 'not-an-email' })).status).toBe(400);
    const c = await admin.post('/api/v1/companies', { name: 'Northstar Consulting', accountNumber: 'NS-001', industry: 'Consulting', city: 'Brussels' });
    expect(c.status).toBe(201);
    expect((await admin.post('/api/v1/companies', { name: 'Dup', accountNumber: 'NS-001' })).status).toBe(409);
    const upd = await admin.patch(`/api/v1/companies/${c.body.id}`, { phone: '+32 2 000 00 00' });
    expect(upd.body.phone).toBe('+32 2 000 00 00');
    const list = await admin.get('/api/v1/companies?q=northstar');
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].openTickets).toBe(0);
  });

  it('builds the company workspace summary from related records', async () => {
    const co = await makeCompany(admin, 'Summary Co');
    const contact = await makeContact(admin, co.id);
    const ci = await admin.post('/api/v1/configuration-items', { name: 'SUM-LT-01', ciTypeId: ciType('Laptop'), companyId: co.id, contactId: contact.id });
    await admin.post('/api/v1/tickets', { title: 'Issue', companyId: co.id, contactId: contact.id, configurationItemId: ci.body.id, priorityId: lookups.priorities[0].id });
    const summary = await admin.get(`/api/v1/companies/${co.id}/summary`);
    expect(summary.body.tickets.open).toBe(1);
    expect(summary.body.tickets.critical).toBe(1);
    expect(summary.body.cis.active).toBe(1);
    expect(summary.body.counts.contacts).toBe(1);
    const activity = await admin.get(`/api/v1/companies/${co.id}/activity`);
    expect(activity.body.data.length).toBeGreaterThan(0);
  });

  it('refuses to delete companies with tickets', async () => {
    const co = await makeCompany(admin, 'Keep Co');
    await admin.post('/api/v1/tickets', { title: 'x', companyId: co.id });
    expect((await admin.delete(`/api/v1/companies/${co.id}`)).status).toBe(409);
  });
});

describe('contacts and locations', () => {
  it('manages contacts with primary flag and company-bound locations', async () => {
    const co = await makeCompany(admin, 'Contact Co');
    const other = await makeCompany(admin, 'Other Co');
    const loc = await admin.post('/api/v1/locations', { companyId: co.id, name: 'HQ', city: 'Ghent', isPrimary: true });
    expect(loc.status).toBe(201);
    const otherLoc = await admin.post('/api/v1/locations', { companyId: other.id, name: 'Elsewhere' });
    expect((await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'A', lastName: 'B', locationId: otherLoc.body.id })).status).toBe(400);
    const c = await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Emma', lastName: 'Smith', email: 'Emma@Example.test', locationId: loc.body.id, isPrimary: true });
    expect(c.body.email).toBe('emma@example.test');
    const company = await admin.get(`/api/v1/companies/${co.id}`);
    expect(company.body.primaryContactId).toBe(c.body.id);
    const list = await admin.get(`/api/v1/contacts?companyId=${co.id}`);
    expect(list.body.data[0].locationName).toBe('HQ');
  });
});

describe('configuration items', () => {
  it('creates CIs with numbers and enforces company-bound contacts', async () => {
    const co = await makeCompany(admin, 'CMDB Co');
    const other = await makeCompany(admin, 'CMDB Other');
    const contact = await makeContact(admin, co.id);
    const foreign = await makeContact(admin, other.id, 'Zed', 'Other');
    expect((await admin.post('/api/v1/configuration-items', { name: 'X', ciTypeId: ciType('Laptop'), companyId: co.id, contactId: foreign.id })).status).toBe(400);
    const ci = await admin.post('/api/v1/configuration-items', {
      name: 'NS-LAPTOP-014',
      ciTypeId: ciType('Laptop'),
      companyId: co.id,
      contactId: contact.id,
      manufacturer: 'Dell',
      model: 'Latitude 7440',
      serialNumber: 'ABC1234',
      osName: 'Windows 11 Pro',
      warrantyExpiresAt: '2027-03-31',
    });
    expect(ci.status).toBe(201);
    expect(ci.body.ciNumber).toMatch(/^CI-\d{6}$/);
    expect(ci.body.source).toBe('manual');

    const contactCis = await admin.get(`/api/v1/configuration-items?contactId=${contact.id}`);
    expect(contactCis.body.data[0].name).toBe('NS-LAPTOP-014');
    const bySerial = await admin.get('/api/v1/configuration-items?q=abc1234');
    expect(bySerial.body.total).toBe(1);

    // Moving the CI to another company clears the contact link
    const moved = await admin.patch(`/api/v1/configuration-items/${ci.body.id}`, { companyId: other.id });
    expect(moved.body.contactId).toBeNull();
  });

  it('links CIs to each other and to tickets', async () => {
    const co = await makeCompany(admin, 'Relations Co');
    const sw = await admin.post('/api/v1/configuration-items', { name: 'CORE-SW-01', ciTypeId: ciType('Network Switch'), companyId: co.id });
    const srv = await admin.post('/api/v1/configuration-items', { name: 'SRV-01', ciTypeId: ciType('Server'), companyId: co.id });
    expect((await admin.post(`/api/v1/configuration-items/${srv.body.id}/relations`, { relatedCiId: sw.body.id, type: 'connected_to' })).status).toBe(201);
    expect((await admin.post(`/api/v1/configuration-items/${srv.body.id}/relations`, { relatedCiId: srv.body.id })).status).toBe(400);
    const rel = await admin.get(`/api/v1/configuration-items/${sw.body.id}/relations`);
    expect(rel.body.data[0]).toMatchObject({ ciId: srv.body.id, direction: 'incoming' });

    await admin.post('/api/v1/tickets', { title: 'Server slow', companyId: co.id, configurationItemId: srv.body.id });
    const detail = await admin.get(`/api/v1/configuration-items/${srv.body.id}`);
    expect(detail.body.stats.openTickets).toBe(1);
    const tickets = await admin.get(`/api/v1/tickets?configurationItemId=${srv.body.id}`);
    expect(tickets.body.total).toBe(1);

    await admin.post(`/api/v1/configuration-items/${srv.body.id}/software`, { name: 'Veeam Agent', version: '6.1' });
    expect((await admin.get('/api/v1/software?q=veeam')).body.data[0].installs).toBe(1);
  });

  it('validates custom fields defined by administrators', async () => {
    const def = await admin.post('/api/v1/settings/custom-fields', { entity: 'configuration_item', key: 'rack_unit', label: 'Rack unit', type: 'number' });
    expect(def.status).toBe(201);
    const co = await makeCompany(admin, 'Custom Co');
    const bad = await admin.post('/api/v1/configuration-items', { name: 'R1', ciTypeId: ciType('Server'), companyId: co.id, customFields: { rack_unit: 'abc' } });
    expect(bad.status).toBe(400);
    const ok = await admin.post('/api/v1/configuration-items', { name: 'R1', ciTypeId: ciType('Server'), companyId: co.id, customFields: { rack_unit: '12', unknown: 'x' } });
    expect(ok.body.customFields).toEqual({ rack_unit: 12 });
  });
});

describe('global search', () => {
  it('finds records across types', async () => {
    const co = await makeCompany(admin, 'Searchable Widgets');
    await admin.post('/api/v1/tickets', { title: 'Widget printer failure', companyId: co.id });
    const res = await admin.get('/api/v1/search?q=widget');
    const types = res.body.data.map((h: any) => h.type);
    expect(types).toContain('company');
    expect(types).toContain('ticket');
  });
});

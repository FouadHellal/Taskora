import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeCompany, makeContact, userClient, type Client, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: Client;
let manager: Client;
let lookups: any;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  manager = await userClient(ctx, 'service_desk_manager');
  lookups = (await admin.get('/api/v1/lookups')).body;
});
afterAll(async () => ctx.close());

async function companyWithHistory(name: string) {
  const co = await makeCompany(admin, name);
  const contact = await makeContact(admin, co.id);
  const ci = await admin.post('/api/v1/configuration-items', { name: `${name}-PC`, ciTypeId: lookups.ciTypes[0].id, companyId: co.id, contactId: contact.id });
  const t = await admin.post('/api/v1/tickets', { title: 'Printer', companyId: co.id, contactId: contact.id, configurationItemId: ci.body.id });
  await admin.post(`/api/v1/tickets/${t.body.id}/notes`, { body: 'Looked at it', visibility: 'internal' });
  const te = await admin.post('/api/v1/time-entries', { ticketId: t.body.id, startedAt: new Date().toISOString(), durationMinutes: 30, description: 'Fixed' });
  expect(te.status).toBe(201);
  return { co, contact, ticketId: t.body.id as number };
}

describe('force delete', () => {
  it('refuses normally, previews and then removes a company with everything attached', async () => {
    const { co, ticketId } = await companyWithHistory('Gone Co');
    const keep = await companyWithHistory('Kept Co');

    const plain = await admin.delete(`/api/v1/companies/${co.id}`);
    expect(plain.status).toBe(409);
    expect(plain.body.error.code).toBe('in_use');

    const preview = await admin.delete(`/api/v1/companies/${co.id}?force=preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.name).toBe('Gone Co');
    const count = (table: string) => preview.body.removed.find((r: { table: string }) => r.table === table)?.count ?? 0;
    expect(count('tickets')).toBe(1);
    expect(count('contacts')).toBe(1);
    expect(count('configuration_items')).toBe(1);
    expect(count('ticket_notes')).toBeGreaterThanOrEqual(1);
    expect(count('time_entries')).toBe(1);
    // A preview changes nothing.
    expect((await admin.get(`/api/v1/tickets/${ticketId}`)).status).toBe(200);

    const done = await admin.delete(`/api/v1/companies/${co.id}?force=true`);
    expect(done.status).toBe(200);
    expect(done.body.forced).toBe(true);
    expect((await admin.get(`/api/v1/companies/${co.id}`)).status).toBe(404);
    expect((await admin.get(`/api/v1/tickets/${ticketId}`)).status).toBe(404);
    // Other companies are untouched.
    expect((await admin.get(`/api/v1/tickets/${keep.ticketId}`)).status).toBe(200);
    expect((await admin.get(`/api/v1/contacts/${keep.contact.id}`)).status).toBe(200);

    const log = await admin.get('/api/v1/audit-logs?entityType=companies');
    expect(JSON.stringify(log.body)).toContain('Force-deleted');
  });

  it('is only available to super administrators', async () => {
    const { co } = await companyWithHistory('Manager Co');
    expect((await manager.delete(`/api/v1/companies/${co.id}?force=preview`)).status).toBe(403);
    expect((await manager.delete(`/api/v1/companies/${co.id}?force=true`)).status).toBe(403);
  });

  it('moves tickets to another value when deleting a picklist entry', async () => {
    const created = await admin.post('/api/v1/settings/queues', { name: 'Temporary queue' });
    expect(created.status).toBe(201);
    const target = lookups.queues[0];
    const co = await makeCompany(admin, 'Queue Co');
    const t = await admin.post('/api/v1/tickets', { title: 'In temp queue', companyId: co.id, queueId: created.body.id });
    const preview = await admin.delete(`/api/v1/settings/queues/${created.body.id}?force=preview`);
    expect(preview.body.reassign).toBe(true);
    expect(preview.body.options.some((o: { id: number }) => o.id === target.id)).toBe(true);
    const res = await admin.delete(`/api/v1/settings/queues/${created.body.id}?force=true&replaceWith=${target.id}`);
    expect(res.status).toBe(200);
    const after = await admin.get(`/api/v1/tickets/${t.body.id}`);
    expect(after.status).toBe(200);
    expect(after.body.queueId).toBe(target.id);
  });
});

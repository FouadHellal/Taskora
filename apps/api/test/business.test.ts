import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, makeCompany, userClient, type Client, type TestContext } from './helpers.js';
import { runStatusAgeRules } from '../src/modules/automation/engine.js';
import { schema } from '../src/db/client.js';
import { eq } from 'drizzle-orm';

let ctx: TestContext;
let admin: Client & { userId: number };
let tech: Client & { userId: number };
let lookups: any;
const workType = (name: string) => lookups.workTypes.find((w: { name: string }) => w.name === name).id;
const status = (name: string) => lookups.statuses.find((s: { name: string }) => s.name === name).id;
const priority = (name: string) => lookups.priorities.find((s: { name: string }) => s.name === name).id;
const queue = (name: string) => lookups.queues.find((s: { name: string }) => s.name === name).id;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  tech = await userClient(ctx, 'technician');
  lookups = (await admin.get('/api/v1/lookups')).body;
});
afterAll(async () => ctx.close());

describe('time entries', () => {
  it('validates and links time to a ticket, deriving company and rates', async () => {
    const co = await makeCompany(admin, 'Time Co');
    const { body: t } = await tech.post('/api/v1/tickets', { title: 'Slow PC', companyId: co.id });
    expect((await tech.post('/api/v1/time-entries', { startedAt: new Date().toISOString(), durationMinutes: 30, description: 'x' })).status).toBe(400);
    expect((await tech.post('/api/v1/time-entries', { ticketId: t.id, startedAt: new Date().toISOString(), durationMinutes: 0, description: 'x' })).status).toBe(400);
    expect((await tech.post('/api/v1/time-entries', { ticketId: t.id, startedAt: new Date().toISOString(), durationMinutes: 30, description: '' })).status).toBe(400);
    const res = await tech.post('/api/v1/time-entries', {
      ticketId: t.id,
      startedAt: new Date().toISOString(),
      durationMinutes: 45,
      description: 'Cleaned startup items',
      workTypeId: workType('Remote Support'),
    });
    expect(res.status).toBe(201);
    expect(res.body.companyId).toBe(co.id);
    expect(res.body.hourlyRate).toBe(95);
    expect(res.body.billable).toBe(true);
    const detail = await tech.get(`/api/v1/tickets/${t.id}`);
    expect(detail.body.minutesWorked).toBe(45);
  });

  it('prevents technicians from logging time for others', async () => {
    const co = await makeCompany(admin, 'Other Time Co');
    const { body: t } = await tech.post('/api/v1/tickets', { title: 'x', companyId: co.id });
    const res = await tech.post('/api/v1/time-entries', { userId: admin.userId, ticketId: t.id, startedAt: new Date().toISOString(), durationMinutes: 10, description: 'x' });
    expect(res.status).toBe(403);
  });

  it('runs a timer and converts it into an entry', async () => {
    const co = await makeCompany(admin, 'Timer Co');
    const { body: t } = await tech.post('/api/v1/tickets', { title: 'Timer ticket', companyId: co.id });
    expect((await tech.post('/api/v1/timer/start', { ticketId: t.id })).status).toBe(200);
    expect((await tech.post('/api/v1/timer/start', { ticketId: t.id })).status).toBe(400);
    expect((await tech.get('/api/v1/timer')).body.ticketNumber).toBe(t.ticketNumber);
    const stop = await tech.post('/api/v1/timer/stop', { description: 'Worked on it' });
    expect(stop.status).toBe(201);
    expect(stop.body.durationMinutes).toBeGreaterThanOrEqual(1);
    expect((await tech.get('/api/v1/timer')).body).toBeNull();
  });
});

describe('contracts and billing', () => {
  it('applies contract SLA and rates, flags covered time, and drafts invoices', async () => {
    const co = await makeCompany(admin, 'Contract Co');
    const premium = lookups.slaPolicies.find((p: { name: string }) => p.name === 'Premium SLA').id;
    const tm = await admin.post('/api/v1/contracts', { name: 'T&M 2026', companyId: co.id, type: 'time_materials', startDate: '2026-01-01', hourlyRate: 100, isDefault: true, slaId: premium });
    expect(tm.status).toBe(201);
    expect(tm.body.contractNumber).toMatch(/^CTR-/);
    await admin.put(`/api/v1/contracts/${tm.body.id}/rates`, [{ workTypeId: workType('Onsite Support'), hourlyRate: 140 }]);

    const { body: ticket } = await tech.post('/api/v1/tickets', { title: 'Onsite fix', companyId: co.id });
    expect(ticket.contractId).toBe(tm.body.id);
    expect(ticket.slaId).toBe(premium);

    const e1 = await tech.post('/api/v1/time-entries', { ticketId: ticket.id, startedAt: '2026-10-05T09:00:00Z', durationMinutes: 60, description: 'Onsite', workTypeId: workType('Onsite Support') });
    expect(e1.body.hourlyRate).toBe(140);
    expect(e1.body.contractCovered).toBe(false);

    const managed = await admin.post('/api/v1/contracts', { name: 'Managed', companyId: co.id, type: 'recurring', startDate: '2026-01-01', recurringAmount: 500 });
    const { body: t2 } = await tech.post('/api/v1/tickets', { title: 'Covered', companyId: co.id, contractId: managed.body.id });
    const e2 = await tech.post('/api/v1/time-entries', { ticketId: t2.id, startedAt: '2026-10-06T09:00:00Z', durationMinutes: 30, description: 'Covered', workTypeId: workType('Remote Support') });
    expect(e2.body.contractCovered).toBe(true);

    const usage = await admin.get(`/api/v1/contracts/${managed.body.id}`);
    expect(usage.body.usage.coveredMinutes).toBe(30);

    const review = await admin.get('/api/v1/billing/review?from=2026-10-01&to=2026-10-31');
    const row = review.body.data.find((r: any) => r.companyId === co.id);
    expect(row.billableMinutes).toBe(60);
    expect(row.contractCoveredMinutes).toBe(30);

    await admin.post('/api/v1/expenses', { companyId: co.id, ticketId: ticket.id, expenseDate: '2026-10-05', description: 'Parking', amount: 12.5 });
    const inv = await admin.post('/api/v1/invoices/draft', { companyId: co.id, periodStart: '2026-10-01', periodEnd: '2026-10-31', taxRate: 21 });
    expect(inv.status).toBe(201);
    const kinds = inv.body.lines.map((l: any) => l.kind).sort();
    expect(kinds).toEqual(['expense', 'service', 'time']);
    expect(inv.body.subtotal).toBe(140 + 12.5 + 500);
    expect(inv.body.total).toBeCloseTo((140 + 12.5 + 500) * 1.21, 2);

    // Billed items are not drafted twice.
    const again = await admin.post('/api/v1/invoices/draft', { companyId: co.id, periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/Nothing to bill/);

    const issued = await admin.patch(`/api/v1/invoices/${inv.body.id}`, { status: 'issued' });
    expect(issued.body.status).toBe('issued');
    const entry = (await admin.get(`/api/v1/time-entries?ticketId=${ticket.id}`)).body.data[0];
    expect(entry.status).toBe('billed');
    expect((await admin.patch(`/api/v1/time-entries/${entry.id}`, { description: 'changed' })).status).toBe(400);

    const pdf = await admin.request('GET', `/api/v1/invoices/${inv.body.id}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    // Voiding releases the time entries back to approved.
    await admin.patch(`/api/v1/invoices/${inv.body.id}`, { status: 'void' });
    const released = (await admin.get(`/api/v1/time-entries?ticketId=${ticket.id}`)).body.data[0];
    expect(released.status).toBe('approved');
    expect(released.invoiceId).toBeNull();
  });

  it('rejects contracts that end before they start', async () => {
    const co = await makeCompany(admin, 'Date Co');
    const res = await admin.post('/api/v1/contracts', { name: 'Bad', companyId: co.id, type: 'block_hours', startDate: '2026-05-01', endDate: '2026-04-01' });
    expect(res.status).toBe(400);
  });
});

describe('workflow automation', () => {
  it('routes critical tickets, notifies, logs execution and does not loop', async () => {
    const rule = await admin.post('/api/v1/workflow-rules', {
      name: 'Critical to L2',
      trigger: 'ticket.created',
      conditions: [{ field: 'priorityId', operator: 'eq', value: priority('Critical') }],
      actions: [
        { type: 'set_queue', value: queue('Level 2 Support') },
        { type: 'assign_user', value: tech.userId },
        { type: 'add_tag', value: 'major-incident' },
      ],
    });
    expect(rule.status).toBe(201);
    // A rule reacting to updates that would re-trigger itself if loops were possible.
    await admin.post('/api/v1/workflow-rules', {
      name: 'Tag escalations',
      trigger: 'ticket.updated',
      conditions: [{ field: 'queueId', operator: 'eq', value: queue('Level 2 Support') }],
      actions: [{ type: 'add_note', value: 'Escalated to L2' }],
    });
    const co = await makeCompany(admin, 'Workflow Co');
    const { body: t } = await admin.post('/api/v1/tickets', { title: 'Everything is down', companyId: co.id, priorityId: priority('Critical') });
    const row = (await admin.get(`/api/v1/tickets/${t.id}`)).body;
    expect(row.queueId).toBe(queue('Level 2 Support'));
    expect(row.assignedUserId).toBe(tech.userId);
    expect(row.tags).toContain('major-incident');
    const execs = await admin.get(`/api/v1/workflow-executions?ticketId=${t.id}`);
    // Only the creation rule ran: automated changes never trigger "updated" rules.
    expect(execs.body.data.map((e: any) => e.ruleName)).toEqual(['Critical to L2']);
    const n = await tech.get('/api/v1/notifications');
    expect(n.body.data.some((x: any) => x.entityId === t.id)).toBe(true);
  });

  it('fires status-age rules once per status period', async () => {
    await admin.post('/api/v1/workflow-rules', {
      name: 'Chase customer',
      trigger: 'ticket.status_age',
      delayMinutes: 60,
      conditions: [{ field: 'statusId', operator: 'eq', value: status('Waiting for Customer') }],
      actions: [{ type: 'notify_assignee' }, { type: 'add_note', value: 'Reminder: customer has not responded' }],
    });
    const co = await makeCompany(admin, 'Waiting Co');
    const { body: t } = await admin.post('/api/v1/tickets', { title: 'Need info', companyId: co.id, assignedUserId: tech.userId, statusId: status('Waiting for Customer') });
    expect(await runStatusAgeRules(ctx.db)).toBe(0);
    await ctx.db.update(schema.tickets).set({ statusChangedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(schema.tickets.id, t.id));
    expect(await runStatusAgeRules(ctx.db)).toBe(1);
    expect(await runStatusAgeRules(ctx.db)).toBe(0);
  });
});

describe('projects and knowledge', () => {
  it('tracks project tasks, progress and logged hours', async () => {
    const co = await makeCompany(admin, 'Project Co');
    const p = await admin.post('/api/v1/projects', { name: 'M365 migration', companyId: co.id, estimatedHours: 40, status: 'active' });
    expect(p.body.projectNumber).toMatch(/^PRJ-/);
    const m = await admin.post(`/api/v1/projects/${p.body.id}/milestones`, { name: 'Mailboxes moved', dueDate: '2026-11-30' });
    const t1 = await admin.post(`/api/v1/projects/${p.body.id}/tasks`, { title: 'Plan cutover', milestoneId: m.body.id, assignedUserId: tech.userId });
    await admin.post(`/api/v1/projects/${p.body.id}/tasks`, { title: 'Migrate mailboxes' });
    await admin.patch(`/api/v1/project-tasks/${t1.body.id}`, { status: 'done' });
    await tech.post('/api/v1/time-entries', { projectTaskId: t1.body.id, startedAt: new Date().toISOString(), durationMinutes: 90, description: 'Planning' });
    const detail = await admin.get(`/api/v1/projects/${p.body.id}`);
    expect(detail.body.progress).toBe(50);
    expect(detail.body.actualMinutes).toBe(90);
    expect(detail.body.tasks.find((x: any) => x.id === t1.body.id).actualMinutes).toBe(90);
  });

  it('publishes, searches and links knowledge base articles', async () => {
    const a = await tech.post('/api/v1/kb/articles', { title: 'Reset an Outlook profile', body: '1. Close Outlook\n2. Open Mail in Control Panel', tags: ['outlook'], status: 'published' });
    expect(a.body.articleNumber).toMatch(/^KB-/);
    expect((await tech.get('/api/v1/kb/articles?scope=kb')).status).toBe(200);
    expect((await tech.get('/api/v1/kb/articles?scope=docs')).status).toBe(200);
    const found = await tech.get('/api/v1/kb/articles?q=outlook');
    expect(found.body.data[0].id).toBe(a.body.id);
    const co = await makeCompany(admin, 'KB Co');
    const { body: t } = await tech.post('/api/v1/tickets', { title: 'Outlook', companyId: co.id });
    await tech.post(`/api/v1/kb/articles/${a.body.id}/tickets`, { ticketId: t.id });
    expect((await tech.get(`/api/v1/tickets/${t.id}/kb`)).body.data[0].id).toBe(a.body.id);
  });
});

describe('dashboard and reports', () => {
  it('computes dashboard statistics and CSV reports from real data', async () => {
    const dash = await admin.get('/api/v1/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.body.kpi.openTickets).toBeGreaterThan(0);
    expect(dash.body.byStatus.length).toBeGreaterThan(0);
    expect(dash.body.trend.length).toBeGreaterThan(25);
    const report = await admin.get('/api/v1/reports/tickets?group=company');
    expect(report.body.data.length).toBeGreaterThan(0);
    const time = await admin.get('/api/v1/reports/time?group=user');
    expect(time.status).toBe(200);
    const csv = await admin.request('GET', '/api/v1/reports/sla?group=priority&format=csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect((await admin.get('/api/v1/reports/assets?group=type')).status).toBe(200);
    const ro = await userClient(ctx, 'read_only');
    expect((await ro.get('/api/v1/reports/tickets')).status).toBe(200);
    expect((await ro.get('/api/v1/my-work')).status).toBe(200);
  });
});

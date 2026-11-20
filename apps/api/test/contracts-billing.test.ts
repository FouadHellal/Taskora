import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, makeCompany, userClient, type Client, type TestContext } from './helpers.js';
import { schema } from '../src/db/client.js';
import { saveSystemSettings } from '../src/lib/settings.js';
import { addDays, addMonths, billingPeriods } from '../src/modules/billing/engine.js';
import { allocate, type ContractTerms } from '../src/modules/contracts/coverage.js';

let ctx: TestContext;
let admin: Client & { userId: number };
let lookups: any;
const workType = (name: string) => lookups.workTypes.find((w: { name: string }) => w.name === name).id;
const status = (name: string) => lookups.statuses.find((s: { name: string }) => s.name === name).id;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  lookups = (await admin.get('/api/v1/lookups')).body;
});
afterAll(async () => ctx.close());

async function contract(companyId: number, body: Record<string, unknown>) {
  const res = await admin.post('/api/v1/contracts', { name: `C ${Math.random().toString(36).slice(2, 7)}`, companyId, startDate: '2026-01-01', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; contractNumber: string };
}
async function ticket(companyId: number, contractId: number | null, title = 'Work') {
  const res = await admin.post('/api/v1/tickets', { title, companyId, contractId });
  expect(res.status).toBe(201);
  return res.body as { id: number; ticketNumber: string };
}
async function time(ticketId: number, startedAt: string, durationMinutes: number, extra: Record<string, unknown> = {}) {
  const res = await admin.post('/api/v1/time-entries', { ticketId, startedAt, durationMinutes, description: 'work', workTypeId: workType('Remote Support'), ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; contractCovered: boolean; coveredMinutes: number; hourlyRate: number };
}
const entry = async (id: number) => (await ctx.db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, id)))[0]!;
const draft = (companyId: number, periodStart: string, periodEnd: string, extra: Record<string, unknown> = {}) =>
  admin.post('/api/v1/invoices/draft', { companyId, periodStart, periodEnd, ...extra });

describe('pure helpers', () => {
  it('computes anchored billing periods with proration', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    const monthlyOnYear = billingPeriods('2026-01-01', 'monthly', '2026-01-01', null, '2026-01-01', '2026-12-31');
    expect(monthlyOnYear).toHaveLength(12);
    const quarterlyOnNov = billingPeriods('2026-01-01', 'quarterly', '2026-01-01', null, '2026-11-01', '2026-11-30');
    expect(quarterlyOnNov).toHaveLength(0);
    const quarterlyOnOct = billingPeriods('2026-01-01', 'quarterly', '2026-01-01', null, '2026-10-01', '2026-10-31');
    expect(quarterlyOnOct).toEqual([{ periodStart: '2026-10-01', periodEnd: '2026-12-31', from: '2026-10-01', to: '2026-12-31', fraction: 1 }]);
    const lastPartial = billingPeriods('2026-01-01', 'monthly', '2026-01-01', '2026-10-15', '2026-10-01', '2026-10-31');
    expect(lastPartial[0]!.fraction).toBeCloseTo(15 / 31, 6);
  });

  it('allocates block hours oldest block first, within block dates', () => {
    const c: ContractTerms = {
      id: 1, companyId: 1, type: 'block_hours', status: 'active', startDate: '2026-01-01', endDate: null, hourlyRate: null, overageRate: 150,
      rates: new Map(), excluded: new Set(),
      blocks: [
        { id: 2, hours: 1, amount: null, startDate: '2026-06-01', endDate: null, isPaid: true },
        { id: 1, hours: 1, amount: null, startDate: '2026-01-01', endDate: '2026-03-31', isPaid: true },
      ],
    };
    const e = (id: number, date: string, minutes: number) => ({ id, date, minutes, billable: true, workTypeId: null, status: 'approved', locked: false, storedCovered: 0 });
    const a = allocate(c, [e(1, '2026-02-01', 90), e(2, '2026-05-01', 30), e(3, '2026-07-01', 90)]);
    expect(a.covered.get(1)).toBe(60); // only the Q1 block is valid in February
    expect(a.covered.get(2)).toBe(0); // gap between blocks
    expect(a.covered.get(3)).toBe(60);
    expect(a.blockUsed.get(1)).toBe(60);
    expect(a.blockUsed.get(2)).toBe(60);
  });
});

describe('block hours and retainers', () => {
  it('covers time up to the hours left and bills the overage at the overage rate', async () => {
    const co = await makeCompany(admin, 'Block Co');
    const c = await contract(co.id, { type: 'block_hours', hourlyRate: 100, overageRate: 150 });
    const b = await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 2, startDate: '2026-09-01', isPaid: true });
    expect(b.status).toBe(201);
    const t = await ticket(co.id, c.id);
    const e1 = await time(t.id, '2026-10-02T09:00:00Z', 90);
    expect(e1.contractCovered).toBe(true);
    expect(e1.coveredMinutes).toBe(90);
    const e2 = await time(t.id, '2026-10-03T09:00:00Z', 60);
    expect(e2.contractCovered).toBe(false);
    expect(e2.coveredMinutes).toBe(30);
    expect(e2.hourlyRate).toBe(150);

    // Shrinking the first entry frees hours: the second becomes fully covered.
    expect((await admin.patch(`/api/v1/time-entries/${e1.id}`, { durationMinutes: 30 })).status).toBe(200);
    expect((await entry(e2.id)).coveredMinutes).toBe(60);
    // Growing it again consumes them.
    await admin.patch(`/api/v1/time-entries/${e1.id}`, { durationMinutes: 90 });
    expect((await entry(e2.id)).coveredMinutes).toBe(30);

    const detail = (await admin.get(`/api/v1/contracts/${c.id}`)).body;
    expect(detail.usage.usedHours).toBe(2);
    expect(detail.usage.remainingHours).toBe(0);
    expect(detail.usage.overageMinutes).toBe(30);
    expect(detail.usage.lowBalance).toBe(true);
    expect(detail.blocks[0]).toMatchObject({ usedHours: 2, remainingHours: 0 });

    const inv = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(inv.status).toBe(201);
    const timeLines = inv.body.lines.filter((l: any) => l.kind === 'time');
    expect(timeLines).toHaveLength(1);
    expect(timeLines[0]).toMatchObject({ timeEntryId: e2.id, quantity: 0.5, unitPrice: 150, amount: 75 });

    // Deleting covered time that is not invoiced re-allocates; time on the draft is locked.
    const del = await admin.delete(`/api/v1/time-entries/${e2.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.message).toContain(`draft invoice ${inv.body.invoiceNumber}`);
  });

  it('does not cover time with expired blocks and counts only live blocks as remaining', async () => {
    const co = await makeCompany(admin, 'Expired Block Co');
    const c = await contract(co.id, { type: 'block_hours', hourlyRate: 100 });
    await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 5, startDate: '2026-01-01', endDate: '2026-06-30', isPaid: true });
    await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 3, startDate: '2026-07-01', isPaid: true });
    const t = await ticket(co.id, c.id);
    const late = await time(t.id, '2026-10-05T09:00:00Z', 60);
    expect(late.coveredMinutes).toBe(60);
    const old = await time(t.id, '2026-03-05T09:00:00Z', 60);
    expect(old.coveredMinutes).toBe(60);
    // A rejected entry does not consume hours.
    const rejected = await time(t.id, '2026-10-06T09:00:00Z', 60);
    await admin.post('/api/v1/time-entries/approve', { ids: [rejected.id], status: 'rejected' });
    expect((await entry(rejected.id)).coveredMinutes).toBe(0);

    const detail = (await admin.get(`/api/v1/contracts/${c.id}`)).body;
    expect(detail.usage.purchasedHours).toBe(8);
    expect(detail.usage.usedHours).toBe(2);
    // The expired block's 4 unused hours are lost; the live one has 2 left.
    expect(detail.usage.remainingHours).toBe(2);
    const list = (await admin.get(`/api/v1/contracts?companyId=${co.id}`)).body.data[0];
    expect(list.usedMinutes).toBe(120);
    expect(list.purchasedHours).toBe(8);
    expect(list.remainingHours).toBe(2);
  });

  it('bills retainer overage once its blocks are used', async () => {
    const co = await makeCompany(admin, 'Retainer Co');
    const c = await contract(co.id, { type: 'retainer', recurringAmount: 400, overageRate: 120 });
    await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 1, startDate: '2026-10-01', endDate: '2026-10-31', isPaid: true });
    const t = await ticket(co.id, c.id);
    const e = await time(t.id, '2026-10-10T09:00:00Z', 90);
    expect(e.coveredMinutes).toBe(60);
    const inv = await draft(co.id, '2026-10-01', '2026-10-31');
    const kinds = inv.body.lines.map((l: any) => [l.kind, l.amount]);
    expect(kinds).toContainEqual(['service', 400]);
    expect(kinds).toContainEqual(['time', 60]);
  });

  it('keeps excluded work types billable on a covering contract', async () => {
    const co = await makeCompany(admin, 'Exclusion Co');
    const c = await contract(co.id, { type: 'recurring', recurringAmount: 100 });
    const put = await admin.put(`/api/v1/contracts/${c.id}/exclusions`, { workTypeIds: [workType('Onsite Support')] });
    expect(put.status).toBe(200);
    const t = await ticket(co.id, c.id);
    const remote = await time(t.id, '2026-10-02T09:00:00Z', 60);
    const onsite = await time(t.id, '2026-10-02T11:00:00Z', 60, { workTypeId: workType('Onsite Support') });
    expect(remote.contractCovered).toBe(true);
    expect(onsite.contractCovered).toBe(false);
    expect(onsite.hourlyRate).toBe(120);
    expect((await admin.get(`/api/v1/contracts/${c.id}`)).body.exclusions.map((x: any) => x.workTypeId)).toEqual([workType('Onsite Support')]);
    // Removing the exclusion reclassifies the unbilled entry.
    await admin.put(`/api/v1/contracts/${c.id}/exclusions`, { workTypeIds: [] });
    expect((await entry(onsite.id)).contractCovered).toBe(true);
  });
});

describe('contract charges', () => {
  it('bills a fixed price once, on the draft covering the contract start', async () => {
    const co = await makeCompany(admin, 'Fixed Co');
    await contract(co.id, { type: 'fixed_price', fixedAmount: 1000, startDate: '2026-10-01' });
    const oct = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(oct.status).toBe(201);
    expect(oct.body.lines.map((l: any) => [l.kind, l.amount])).toEqual([['fixed', 1000]]);
    expect((await draft(co.id, '2026-10-01', '2026-10-31')).status).toBe(422);
    expect((await draft(co.id, '2026-11-01', '2026-11-30')).status).toBe(422);
    // Voiding the invoice makes it billable again.
    await admin.patch(`/api/v1/invoices/${oct.body.id}`, { status: 'void' });
    expect((await draft(co.id, '2026-10-01', '2026-10-31')).status).toBe(201);
  });

  it('bills unpaid hour blocks and marks them paid with the invoice', async () => {
    const co = await makeCompany(admin, 'Block Sale Co');
    const c = await contract(co.id, { type: 'block_hours' });
    const paidBlock = await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 5, amount: 400, startDate: '2026-10-01', isPaid: true });
    const block = await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 10, amount: 900, startDate: '2026-10-05' });
    const inv = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(inv.body.lines.map((l: any) => [l.kind, l.amount, l.contractBlockId])).toEqual([['block', 900, block.body.id]]);
    void paidBlock;
    // Billed block amounts are locked while on the invoice.
    expect((await admin.patch(`/api/v1/contracts/${c.id}/blocks/${block.body.id}`, { amount: 1 })).status).toBe(409);
    await admin.patch(`/api/v1/invoices/${inv.body.id}`, { status: 'issued' });
    await admin.patch(`/api/v1/invoices/${inv.body.id}`, { status: 'paid' });
    const blocks = (await admin.get(`/api/v1/contracts/${c.id}`)).body.blocks;
    expect(blocks.find((b: any) => b.id === block.body.id).isPaid).toBe(true);

    // Void un-marks blocks billed on the invoice.
    const b2 = await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 2, amount: 200, startDate: '2026-10-20' });
    const inv2 = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(inv2.body.lines).toHaveLength(1);
    await admin.patch(`/api/v1/invoices/${inv2.body.id}`, { status: 'issued' });
    await admin.patch(`/api/v1/contracts/${c.id}/blocks/${b2.body.id}`, { isPaid: true });
    await admin.patch(`/api/v1/invoices/${inv2.body.id}`, { status: 'void' });
    const after = (await admin.get(`/api/v1/contracts/${c.id}`)).body.blocks.find((b: any) => b.id === b2.body.id);
    expect(after.isPaid).toBe(false);
  });

  it('bills a per-ticket fee once per ticket resolved in the period', async () => {
    const co = await makeCompany(admin, 'Per Ticket Co');
    const c = await contract(co.id, { type: 'per_ticket', perTicketRate: 80 });
    const t1 = await ticket(co.id, c.id, 'Printer');
    await ticket(co.id, c.id, 'Still open');
    await admin.patch(`/api/v1/tickets/${t1.id}`, { statusId: status('Resolved') });
    const start = `${new Date().toISOString().slice(0, 7)}-01`;
    const last = addDays(addMonths(start, 1), -1);
    const inv = await draft(co.id, start, last);
    expect(inv.status).toBe(201);
    expect(inv.body.lines.map((l: any) => [l.kind, l.amount, l.ticketId])).toEqual([['ticket', 80, t1.id]]);
    expect((await draft(co.id, start, last)).status).toBe(422);
  });

  it('bills recurring fees per billing frequency, anchored on the contract start, idempotently', async () => {
    const co = await makeCompany(admin, 'Frequency Co');
    const q = await contract(co.id, { type: 'recurring', recurringAmount: 300, billingPeriod: 'quarterly' });
    const m = await contract(co.id, { type: 'recurring', recurringAmount: 100, billingPeriod: 'monthly' });
    const oct = await draft(co.id, '2026-10-01', '2026-10-31');
    const fee = (inv: any, id: number) => inv.body.lines.filter((l: any) => l.contractId === id);
    expect(fee(oct, q.id)).toHaveLength(1);
    expect(fee(oct, q.id)[0]).toMatchObject({ amount: 300, servicePeriodStart: '2026-10-01' });
    expect(fee(oct, m.id)).toHaveLength(1);
    const nov = await draft(co.id, '2026-11-01', '2026-11-30');
    expect(fee(nov, q.id)).toHaveLength(0);
    expect(fee(nov, m.id)).toHaveLength(1);

    // A yearly invoice bills each monthly period once — minus those already billed.
    const year = await draft(co.id, '2026-01-01', '2026-12-31');
    expect(fee(year, m.id)).toHaveLength(10);
    expect(fee(year, q.id)).toHaveLength(3);
  });

  it('respects contract and service dates with prorated partial periods, for any contract type', async () => {
    const co = await makeCompany(admin, 'Dates Co');
    const ended = await contract(co.id, { type: 'recurring', recurringAmount: 310, endDate: '2026-10-15' });
    const svc = await admin.post('/api/v1/services', { name: `Backup ${Date.now()}`, unitPrice: 31, period: 'monthly' });
    expect(svc.status).toBe(201);
    const tm = await contract(co.id, { type: 'time_materials', hourlyRate: 90 });
    const line = await admin.post(`/api/v1/contracts/${tm.id}/services`, { serviceId: svc.body.id, quantity: 2, startDate: '2026-10-16' });
    expect(line.status).toBe(201);
    await contract(co.id, { type: 'recurring', recurringAmount: 999, status: 'cancelled' });
    const inv = await draft(co.id, '2026-10-01', '2026-10-31');
    const byContract = (id: number) => inv.body.lines.filter((l: any) => l.contractId === id);
    expect(byContract(ended.id)[0].amount).toBe(150); // 15/31 of 310
    expect(byContract(tm.id)[0]).toMatchObject({ quantity: 2, amount: 32, contractServiceId: line.body.id }); // 2 × 31 × 16/31
    expect(inv.body.lines.some((l: any) => l.amount === 999)).toBe(false);

    // Service end date stops billing.
    await admin.patch(`/api/v1/contracts/${tm.id}/services/${line.body.id}`, { endDate: '2026-11-10' });
    const nov = await draft(co.id, '2026-11-01', '2026-11-30');
    expect(nov.body.lines.find((l: any) => l.contractServiceId === line.body.id)).toMatchObject({ unitPrice: 10.33, amount: 20.67 }); // 2 × 31 × 10/30
  });

  it('does not cover time on cancelled or not-yet-started contracts', async () => {
    const co = await makeCompany(admin, 'Cancelled Co');
    const c = await contract(co.id, { type: 'recurring', recurringAmount: 100, status: 'cancelled' });
    const t = await ticket(co.id, c.id);
    const e = await time(t.id, '2026-10-02T09:00:00Z', 60);
    expect(e.contractCovered).toBe(false);
    expect(e.hourlyRate).toBe(95);
    const future = await contract(co.id, { type: 'recurring', recurringAmount: 100, startDate: '2026-12-01' });
    const t2 = await ticket(co.id, future.id);
    expect((await time(t2.id, '2026-10-02T09:00:00Z', 60)).contractCovered).toBe(false);
  });
});

describe('time and expense guards', () => {
  it('refuses to change, delete or reject time that sits on a draft invoice', async () => {
    const co = await makeCompany(admin, 'Locked Co');
    const t = await ticket(co.id, null);
    const e = await time(t.id, '2026-10-02T09:00:00Z', 60);
    const x = await admin.post('/api/v1/expenses', { companyId: co.id, expenseDate: '2026-10-02', description: 'Cable', amount: 10 });
    const inv = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(inv.status).toBe(201);
    const patch = await admin.patch(`/api/v1/time-entries/${e.id}`, { durationMinutes: 30 });
    expect(patch.status).toBe(409);
    expect(patch.body.error.message).toBe(`This time entry is on draft invoice ${inv.body.invoiceNumber} — remove it from the invoice first`);
    expect((await admin.post('/api/v1/time-entries/approve', { ids: [e.id], status: 'rejected' })).status).toBe(409);
    expect((await admin.delete(`/api/v1/expenses/${x.body.id}`)).status).toBe(409);
    // Once removed from the invoice, it can be edited again.
    const line = inv.body.lines.find((l: any) => l.timeEntryId === e.id);
    await admin.delete(`/api/v1/invoices/${inv.body.id}/lines/${line.id}`);
    expect((await admin.patch(`/api/v1/time-entries/${e.id}`, { durationMinutes: 30 })).status).toBe(200);
  });

  it("rejects another company's contract on time and expenses", async () => {
    const a = await makeCompany(admin, 'Company A');
    const b = await makeCompany(admin, 'Company B');
    const cb = await contract(b.id, { type: 'recurring', recurringAmount: 10 });
    const ta = await ticket(a.id, null);
    expect((await admin.post('/api/v1/time-entries', { ticketId: ta.id, contractId: cb.id, startedAt: '2026-10-02T09:00:00Z', durationMinutes: 30, description: 'x' })).status).toBe(400);
    const e = await time(ta.id, '2026-10-02T09:00:00Z', 30);
    expect((await admin.patch(`/api/v1/time-entries/${e.id}`, { contractId: cb.id })).status).toBe(400);
    expect((await admin.post('/api/v1/expenses', { companyId: a.id, contractId: cb.id, expenseDate: '2026-10-02', description: 'x', amount: 1 })).status).toBe(400);
  });

  it('reclassifies unbilled time when the ticket moves to another contract', async () => {
    const co = await makeCompany(admin, 'Move Co');
    const tm = await contract(co.id, { type: 'time_materials', hourlyRate: 90 });
    const covered = await contract(co.id, { type: 'recurring', recurringAmount: 50 });
    const t = await ticket(co.id, tm.id);
    const e = await time(t.id, '2026-10-02T09:00:00Z', 60);
    expect(e.hourlyRate).toBe(90);
    await admin.patch(`/api/v1/tickets/${t.id}`, { contractId: covered.id });
    const moved = await entry(e.id);
    expect(moved.contractId).toBe(covered.id);
    expect(moved.contractCovered).toBe(true);
    await admin.patch(`/api/v1/tickets/${t.id}`, { contractId: null });
    const none = await entry(e.id);
    expect(none.contractId).toBeNull();
    expect(none.contractCovered).toBe(false);
    expect(none.hourlyRate).toBe(95);
  });
});

describe('contract API details', () => {
  it('patches service lines and blocks with only the keys sent', async () => {
    const co = await makeCompany(admin, 'Patch Co');
    const c = await contract(co.id, { type: 'recurring', recurringAmount: 10 });
    const svc = await admin.post('/api/v1/services', { name: `Monitoring ${Date.now()}`, unitPrice: 5 });
    const line = await admin.post(`/api/v1/contracts/${c.id}/services`, { serviceId: svc.body.id, quantity: 3 });
    const res = await admin.patch(`/api/v1/contracts/${c.id}/services/${line.body.id}`, { unitPrice: 7 });
    expect(res.body).toMatchObject({ quantity: 3, unitPrice: 7 });

    const block = await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 4, amount: 300, startDate: '2026-10-01' });
    const p = await admin.patch(`/api/v1/contracts/${c.id}/blocks/${block.body.id}`, { isPaid: true, endDate: '2026-12-31' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ hours: 4, amount: 300, isPaid: true, endDate: '2026-12-31' });
    expect((await admin.patch(`/api/v1/contracts/${c.id}/blocks/${block.body.id}`, { endDate: '2026-01-01' })).status).toBe(400);
  });
});

describe('invoices', () => {
  it('multiplies minutes by rate before rounding', async () => {
    const co = await makeCompany(admin, 'Rounding Co');
    const c = await contract(co.id, { type: 'time_materials', hourlyRate: 100 });
    const t = await ticket(co.id, c.id);
    await time(t.id, '2026-10-02T09:00:00Z', 20);
    const inv = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(inv.body.lines[0]).toMatchObject({ quantity: 0.33, amount: 33.33 });
  });

  it('uses the default tax rate, refuses empty drafts without consuming a number, and locks issued invoices', async () => {
    await saveSystemSettings(ctx.db, { defaultTaxRate: 21 });
    expect((await admin.get('/api/v1/billing/defaults')).body.defaultTaxRate).toBe(21);
    const co = await makeCompany(admin, 'Tax Co');
    const seq = async () => (await ctx.db.select().from(schema.sequences).where(eq(schema.sequences.name, 'invoice')))[0]?.value ?? 0;
    const before = await seq();
    const empty = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(empty.status).toBe(422);
    expect(empty.body.error.message).toMatch(/Nothing to bill/);
    expect(await seq()).toBe(before);
    await admin.post('/api/v1/expenses', { companyId: co.id, expenseDate: '2026-10-02', description: 'Parts', amount: 100 });
    const inv = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(inv.body.taxRate).toBe(21);
    expect(inv.body.total).toBe(121);
    expect(await seq()).toBe(before + 1);
    const explicit = await admin.post('/api/v1/expenses', { companyId: co.id, expenseDate: '2026-10-03', description: 'More', amount: 10 });
    void explicit;
    expect((await draft(co.id, '2026-10-01', '2026-10-31', { taxRate: 0 })).body.taxRate).toBe(0);

    expect((await admin.patch(`/api/v1/invoices/${inv.body.id}`, { notes: 'Thanks' })).status).toBe(200);
    await admin.patch(`/api/v1/invoices/${inv.body.id}`, { status: 'issued' });
    expect((await admin.patch(`/api/v1/invoices/${inv.body.id}`, { notes: 'changed' })).status).toBe(400);
    expect((await admin.patch(`/api/v1/invoices/${inv.body.id}`, { dueDate: '2030-01-01' })).status).toBe(400);
    await saveSystemSettings(ctx.db, { defaultTaxRate: 0 });
  });

  it('previews exactly what a draft would contain without creating anything', async () => {
    const co = await makeCompany(admin, 'Preview Co');
    const c = await contract(co.id, { type: 'block_hours', hourlyRate: 100, overageRate: 130, recurringAmount: 50 });
    await admin.post(`/api/v1/contracts/${c.id}/blocks`, { hours: 1, amount: 90, startDate: '2026-10-01' });
    const t = await ticket(co.id, c.id);
    await time(t.id, '2026-10-02T09:00:00Z', 90);
    await admin.post('/api/v1/expenses', { companyId: co.id, expenseDate: '2026-10-02', description: 'Parts', amount: 12 });
    const before = await ctx.db.select().from(schema.invoices);
    const preview = await admin.get(`/api/v1/billing/preview?companyId=${co.id}&periodStart=2026-10-01&periodEnd=2026-10-31`);
    expect(preview.status).toBe(200);
    expect((await ctx.db.select().from(schema.invoices)).length).toBe(before.length);
    expect(preview.body.lines.map((l: any) => l.kind).sort()).toEqual(['block', 'expense', 'service', 'time']);
    expect(preview.body.subtotal).toBe(50 + 90 + 65 + 12);
    const inv = await draft(co.id, '2026-10-01', '2026-10-31');
    expect(inv.body.lines.map((l: any) => [l.kind, l.description, l.amount])).toEqual(preview.body.lines.map((l: any) => [l.kind, l.description, l.amount]));
    expect(inv.body.subtotal).toBe(preview.body.subtotal);
  });

  it('uses the system timezone for period boundaries', async () => {
    await saveSystemSettings(ctx.db, { timezone: 'Europe/Brussels' });
    try {
      const co = await makeCompany(admin, 'Timezone Co');
      const c = await contract(co.id, { type: 'time_materials', hourlyRate: 100 });
      const t = await ticket(co.id, c.id);
      await time(t.id, '2026-10-31T23:30:00Z', 60); // 1 November 00:30 in Brussels
      expect((await draft(co.id, '2026-10-01', '2026-10-31')).status).toBe(422);
      expect((await draft(co.id, '2026-11-01', '2026-11-30')).status).toBe(201);
      const review = await admin.get('/api/v1/billing/review?from=2026-11-01&to=2026-11-30');
      expect(review.status).toBe(200);
    } finally {
      await saveSystemSettings(ctx.db, { timezone: 'UTC' });
    }
  });
});

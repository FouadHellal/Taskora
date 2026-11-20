import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { contractBlockSchema, contractExclusionsSchema, contractRateSchema, contractSchema, contractServiceSchema, formatNumber } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { countAll, intParam, nextSequence, orderFrom, paginated, parseList, searchAny, whereAll } from '../../lib/query.js';
import { validateCustomFields } from '../../lib/custom-fields.js';
import { getSystemSettings } from '../../lib/settings.js';
import type { Tx } from '../../db/client.js';
import { contractBalances, recomputeCoverage } from './coverage.js';

/** Only the keys present in the request body (Zod `.partial()` keeps `.default()` values). */
function present<T extends Record<string, unknown>>(input: T, body: unknown): Partial<T> {
  const b = (body ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(input).filter(([k]) => k in b)) as Partial<T>;
}

async function clearOtherDefaults(tx: Tx, companyId: number, keepId: number) {
  await tx.update(s.contracts).set({ isDefault: false }).where(and(eq(s.contracts.companyId, companyId), ne(s.contracts.id, keepId)));
}

/** Usage and financial position of a contract (hours via the shared balance helper). */
async function contractUsage(db: Tx, id: number) {
  const [usage] = await db
    .execute<{ minutes: number; billableMinutes: number; billableAmount: number; tickets: number; openTickets: number }>(
      sql`select
        coalesce(sum(te.duration_minutes) filter (where te.status in ('submitted','approved','billed')),0)::int as minutes,
        coalesce(sum(te.duration_minutes) filter (where te.billable and te.status in ('submitted','approved','billed')),0)::int as "billableMinutes",
        coalesce(sum((te.duration_minutes - coalesce(te.covered_minutes, case when te.contract_covered then te.duration_minutes else 0 end)) * coalesce(te.hourly_rate,0) / 60.0)
          filter (where te.billable and te.status in ('submitted','approved','billed')),0)::float as "billableAmount",
        (select count(*) from tickets t where t.contract_id = ${id})::int as tickets,
        (select count(*) from tickets t join ticket_statuses st on st.id = t.status_id where t.contract_id = ${id} and st.category not in ('resolved','closed'))::int as "openTickets"
      from time_entries te where te.contract_id = ${id}`,
    )
    .then((r) => r.rows);
  const [svc] = await db
    .execute<{ recurring: number }>(
      sql`select coalesce(sum(quantity * unit_price),0)::float as recurring from contract_services where contract_id = ${id} and (end_date is null or end_date >= current_date)`,
    )
    .then((r) => r.rows);
  const bal = (await contractBalances(db, [id])).get(id)!;
  return {
    minutes: usage?.minutes ?? 0,
    billableMinutes: usage?.billableMinutes ?? 0,
    coveredMinutes: bal.coveredMinutes,
    overageMinutes: bal.overageMinutes,
    billableAmount: Math.round((usage?.billableAmount ?? 0) * 100) / 100,
    tickets: usage?.tickets ?? 0,
    openTickets: usage?.openTickets ?? 0,
    purchasedHours: bal.purchasedHours,
    usedHours: bal.usedHours,
    remainingHours: bal.remainingHours,
    lowBalance: bal.lowBalance,
    recurringServicesAmount: svc?.recurring ?? 0,
    blocks: bal.blocks,
  };
}

export async function contractRoutes(app: FastifyInstance) {
  app.get('/contracts', { config: { perm: 'contracts.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(
      intParam(q.companyId) ? eq(s.contracts.companyId, intParam(q.companyId)!) : undefined,
      q.status ? inArray(s.contracts.status, String(q.status).split(',')) : undefined,
      q.type ? inArray(s.contracts.type, String(q.type).split(',')) : undefined,
      q.expiring === 'true' ? sql`${s.contracts.endDate} between current_date and current_date + 60` : undefined,
      searchAny(q.q, [s.contracts.name, s.contracts.contractNumber, s.companies.name]),
    );
    const rows = await app.db
      .select({
        id: s.contracts.id,
        contractNumber: s.contracts.contractNumber,
        name: s.contracts.name,
        type: s.contracts.type,
        status: s.contracts.status,
        companyId: s.contracts.companyId,
        companyName: s.companies.name,
        startDate: s.contracts.startDate,
        endDate: s.contracts.endDate,
        isDefault: s.contracts.isDefault,
        slaName: s.slaPolicies.name,
        recurringAmount: s.contracts.recurringAmount,
        billingPeriod: s.contracts.billingPeriod,
      })
      .from(s.contracts)
      .innerJoin(s.companies, eq(s.companies.id, s.contracts.companyId))
      .leftJoin(s.slaPolicies, eq(s.slaPolicies.id, s.contracts.slaId))
      .where(where)
      .orderBy(...orderFrom(q.sort, q.order, { name: s.contracts.name, company: s.companies.name, endDate: s.contracts.endDate, startDate: s.contracts.startDate, type: s.contracts.type }, s.contracts.startDate))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db
      .select({ n: countAll })
      .from(s.contracts)
      .innerJoin(s.companies, eq(s.companies.id, s.contracts.companyId))
      .where(where)) as [{ n: number }];
    const balances = await contractBalances(app.db, rows.map((r) => r.id));
    return paginated(
      rows.map((r) => {
        const b = balances.get(r.id)!;
        // Block contracts show hours used out of purchased hours; others show hours logged.
        return { ...r, usedMinutes: b.purchasedHours > 0 ? b.coveredMinutes : b.loggedMinutes, purchasedHours: b.purchasedHours, remainingHours: b.remainingHours, lowBalance: b.lowBalance };
      }),
      n,
      q,
    );
  });

  app.get('/contracts/:id', { config: { perm: 'contracts.read' } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db
      .select({
        contract: s.contracts,
        companyName: s.companies.name,
        slaName: s.slaPolicies.name,
        contactName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
      })
      .from(s.contracts)
      .innerJoin(s.companies, eq(s.companies.id, s.contracts.companyId))
      .leftJoin(s.slaPolicies, eq(s.slaPolicies.id, s.contracts.slaId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.contracts.contactId))
      .where(eq(s.contracts.id, id));
    if (!row) throw notFound('Contract');
    const [rates, blocks, services, exclusions] = await Promise.all([
      app.db
        .select({ id: s.contractRates.id, workTypeId: s.contractRates.workTypeId, workTypeName: s.workTypes.name, hourlyRate: s.contractRates.hourlyRate })
        .from(s.contractRates)
        .innerJoin(s.workTypes, eq(s.workTypes.id, s.contractRates.workTypeId))
        .where(eq(s.contractRates.contractId, id)),
      app.db.select().from(s.contractBlocks).where(eq(s.contractBlocks.contractId, id)).orderBy(desc(s.contractBlocks.startDate)),
      app.db
        .select({
          id: s.contractServices.id,
          serviceId: s.contractServices.serviceId,
          serviceName: s.services.name,
          period: s.services.period,
          quantity: s.contractServices.quantity,
          unitPrice: s.contractServices.unitPrice,
          startDate: s.contractServices.startDate,
          endDate: s.contractServices.endDate,
        })
        .from(s.contractServices)
        .innerJoin(s.services, eq(s.services.id, s.contractServices.serviceId))
        .where(eq(s.contractServices.contractId, id))
        .orderBy(asc(s.services.name)),
      app.db
        .select({ workTypeId: s.contractExclusions.workTypeId, workTypeName: s.workTypes.name })
        .from(s.contractExclusions)
        .innerJoin(s.workTypes, eq(s.workTypes.id, s.contractExclusions.workTypeId))
        .where(eq(s.contractExclusions.contractId, id))
        .orderBy(asc(s.workTypes.name)),
    ]);
    const usage = await contractUsage(app.db, id);
    const balanceOf = new Map(usage.blocks.map((b) => [b.id, b]));
    return {
      ...row.contract,
      companyName: row.companyName,
      slaName: row.slaName,
      contactName: row.contactName,
      rates,
      blocks: blocks.map((b) => {
        const bal = balanceOf.get(b.id);
        return { ...b, usedHours: bal?.usedHours ?? 0, remainingHours: bal?.remainingHours ?? b.hours, expired: bal?.expired ?? false, active: bal?.active ?? false };
      }),
      services,
      exclusions,
      usage: { ...usage, blocks: undefined },
    };
  });

  app.post('/contracts', { config: { perm: 'contracts.write' } }, async (req, reply) => {
    const input = contractSchema.parse(req.body);
    if (input.endDate && input.endDate < input.startDate) throw badRequest('End date is before start date', { fields: { endDate: 'Must be after the start date' } });
    const row = await app.db.transaction(async (tx) => {
      const settings = await getSystemSettings(tx);
      const customFields = await validateCustomFields(tx, 'contract', input.customFields);
      const [r] = await tx
        .insert(s.contracts)
        .values({ ...input, customFields, contractNumber: formatNumber(settings.contractPrefix, await nextSequence(tx, 'contract')) })
        .returning();
      if (r!.isDefault) await clearOtherDefaults(tx, r!.companyId, r!.id);
      await audit(tx, req, { action: 'create', entityType: 'contract', entityId: r!.id, summary: `${r!.contractNumber} ${r!.name}` });
      return r!;
    });
    return reply.status(201).send(row);
  });

  app.patch('/contracts/:id', { config: { perm: 'contracts.write' } }, async (req) => {
    const id = idOf(req);
    const input = contractSchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    return app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s.contracts).where(eq(s.contracts.id, id));
      if (!before) throw notFound('Contract');
      const data = Object.fromEntries(Object.entries(input).filter(([k]) => k in body && k !== 'companyId')) as Partial<typeof before>;
      if ('customFields' in body) data.customFields = await validateCustomFields(tx, 'contract', input.customFields, before.customFields);
      const start = data.startDate ?? before.startDate;
      const end = 'endDate' in data ? data.endDate : before.endDate;
      if (end && end < start) throw badRequest('End date is before start date', { fields: { endDate: 'Must be after the start date' } });
      const [row] = await tx.update(s.contracts).set(data).where(eq(s.contracts.id, id)).returning();
      if (row!.isDefault) await clearOtherDefaults(tx, row!.companyId, id);
      // Type, status, dates and rates decide coverage and rates of unbilled time.
      await recomputeCoverage(tx, [id]);
      await audit(tx, req, { action: 'update', entityType: 'contract', entityId: id, changes: diff(before, data) });
      return row;
    });
  });

  app.delete('/contracts/:id', { config: { perm: 'contracts.write' } }, async (req) => {
    const id = idOf(req);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.timeEntries).where(eq(s.timeEntries.contractId, id))) as [{ n: number }];
    if (n > 0) throw badRequest('Time has been logged against this contract. Set its status to cancelled instead.');
    const [row] = await app.db.delete(s.contracts).where(eq(s.contracts.id, id)).returning();
    if (!row) throw notFound('Contract');
    await audit(app.db, req, { action: 'delete', entityType: 'contract', entityId: id, summary: row.name });
    return { ok: true };
  });

  /* ---- rates / blocks / services ---- */

  app.put('/contracts/:id/rates', { config: { perm: 'contracts.write' } }, async (req) => {
    const id = idOf(req);
    const rates = contractRateSchema.array().parse(req.body);
    await app.db.transaction(async (tx) => {
      await tx.delete(s.contractRates).where(eq(s.contractRates.contractId, id));
      if (rates.length) await tx.insert(s.contractRates).values(rates.map((r) => ({ ...r, contractId: id })));
      await recomputeCoverage(tx, [id]);
      await audit(tx, req, { action: 'update', entityType: 'contract', entityId: id, summary: 'Rates updated', changes: { rates } });
    });
    return { ok: true };
  });

  /** Work types that stay billable even when the contract would cover the time. */
  app.put('/contracts/:id/exclusions', { config: { perm: 'contracts.write' } }, async (req) => {
    const id = idOf(req);
    const { workTypeIds } = contractExclusionsSchema.parse(req.body);
    const ids = [...new Set(workTypeIds)];
    await app.db.transaction(async (tx) => {
      const [c] = await tx.select({ id: s.contracts.id }).from(s.contracts).where(eq(s.contracts.id, id));
      if (!c) throw notFound('Contract');
      if (ids.length) {
        const found = await tx.select({ id: s.workTypes.id }).from(s.workTypes).where(inArray(s.workTypes.id, ids));
        if (found.length !== ids.length) throw badRequest('Unknown work type');
      }
      await tx.delete(s.contractExclusions).where(eq(s.contractExclusions.contractId, id));
      if (ids.length) await tx.insert(s.contractExclusions).values(ids.map((workTypeId) => ({ contractId: id, workTypeId })));
      await recomputeCoverage(tx, [id]);
      await audit(tx, req, { action: 'update', entityType: 'contract', entityId: id, summary: 'Billable exclusions updated', changes: { workTypeIds: ids } });
    });
    return { ok: true, workTypeIds: ids };
  });

  const contractOr404 = async (db: Tx, id: number) => {
    const [c] = await db.select().from(s.contracts).where(eq(s.contracts.id, id));
    if (!c) throw notFound('Contract');
    return c;
  };
  const checkBlockDates = (start: string, end: string | null | undefined) => {
    if (end && end < start) throw badRequest('The block expires before it starts', { fields: { endDate: 'Must be after the start date' } });
  };
  /** A block billed on a live invoice keeps its hours and amount. */
  const blockInvoice = async (db: Tx, blockId: number) => {
    const [row] = await db
      .select({ number: s.invoices.invoiceNumber, status: s.invoices.status })
      .from(s.invoiceLines)
      .innerJoin(s.invoices, eq(s.invoices.id, s.invoiceLines.invoiceId))
      .where(and(eq(s.invoiceLines.contractBlockId, blockId), ne(s.invoices.status, 'void')))
      .limit(1);
    return row;
  };

  app.post('/contracts/:id/blocks', { config: { perm: 'contracts.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = contractBlockSchema.parse(req.body);
    checkBlockDates(input.startDate, input.endDate);
    const row = await app.db.transaction(async (tx) => {
      await contractOr404(tx, id);
      const [r] = await tx.insert(s.contractBlocks).values({ ...input, contractId: id }).returning();
      await recomputeCoverage(tx, [id]);
      await audit(tx, req, { action: 'update', entityType: 'contract', entityId: id, summary: `Block of ${input.hours} h added` });
      return r!;
    });
    return reply.status(201).send(row);
  });
  app.patch('/contracts/:id/blocks/:blockId', { config: { perm: 'contracts.write' } }, async (req) => {
    const id = idOf(req);
    const blockId = idOf(req, 'blockId');
    const data = present(contractBlockSchema.partial().parse(req.body), req.body);
    return app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s.contractBlocks).where(and(eq(s.contractBlocks.id, blockId), eq(s.contractBlocks.contractId, id)));
      if (!before) throw notFound('Hour block');
      checkBlockDates(data.startDate ?? before.startDate, 'endDate' in data ? data.endDate : before.endDate);
      if (('hours' in data && data.hours !== before.hours) || ('amount' in data && data.amount !== before.amount)) {
        const inv = await blockInvoice(tx, blockId);
        if (inv) throw conflict(`This block is billed on ${inv.status} invoice ${inv.number} — remove it from the invoice first`);
      }
      const [row] = await tx.update(s.contractBlocks).set(data).where(eq(s.contractBlocks.id, blockId)).returning();
      await recomputeCoverage(tx, [id]);
      await audit(tx, req, { action: 'update', entityType: 'contract', entityId: id, summary: `Block ${blockId} updated`, changes: diff(before, data) });
      return row;
    });
  });
  app.delete('/contracts/:id/blocks/:blockId', { config: { perm: 'contracts.write' } }, async (req) => {
    const id = idOf(req);
    const blockId = idOf(req, 'blockId');
    await app.db.transaction(async (tx) => {
      const inv = await blockInvoice(tx, blockId);
      if (inv) throw conflict(`This block is billed on ${inv.status} invoice ${inv.number} — remove it from the invoice first`);
      const [row] = await tx.delete(s.contractBlocks).where(and(eq(s.contractBlocks.id, blockId), eq(s.contractBlocks.contractId, id))).returning();
      if (!row) throw notFound('Hour block');
      await recomputeCoverage(tx, [id]);
      await audit(tx, req, { action: 'update', entityType: 'contract', entityId: id, summary: `Block of ${row.hours} h removed` });
    });
    return { ok: true };
  });

  app.post('/contracts/:id/services', { config: { perm: 'contracts.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = contractServiceSchema.parse(req.body);
    const [svc] = await app.db.select().from(s.services).where(eq(s.services.id, input.serviceId));
    if (!svc) throw badRequest('Unknown service');
    if (input.startDate && input.endDate && input.endDate < input.startDate) throw badRequest('End date is before start date', { fields: { endDate: 'Must be after the start date' } });
    const [row] = await app.db
      .insert(s.contractServices)
      .values({ contractId: id, serviceId: input.serviceId, quantity: input.quantity, unitPrice: input.unitPrice ?? svc.unitPrice, startDate: input.startDate, endDate: input.endDate })
      .returning();
    await audit(app.db, req, { action: 'update', entityType: 'contract', entityId: id, summary: `Service ${svc.name} added` });
    return reply.status(201).send(row);
  });
  app.patch('/contracts/:id/services/:serviceLineId', { config: { perm: 'contracts.write' } }, async (req) => {
    const id = idOf(req);
    const lineId = idOf(req, 'serviceLineId');
    const input = present(contractServiceSchema.partial().parse(req.body), req.body);
    const [before] = await app.db.select().from(s.contractServices).where(and(eq(s.contractServices.id, lineId), eq(s.contractServices.contractId, id)));
    if (!before) throw notFound('Contract service');
    const data: Partial<typeof before> = {};
    if ('quantity' in input) data.quantity = input.quantity!;
    if ('unitPrice' in input && input.unitPrice != null) data.unitPrice = input.unitPrice;
    if ('startDate' in input) data.startDate = input.startDate ?? null;
    if ('endDate' in input) data.endDate = input.endDate ?? null;
    const start = 'startDate' in data ? data.startDate : before.startDate;
    const end = 'endDate' in data ? data.endDate : before.endDate;
    if (start && end && end < start) throw badRequest('End date is before start date', { fields: { endDate: 'Must be after the start date' } });
    if (!Object.keys(data).length) return before;
    const [row] = await app.db.update(s.contractServices).set(data).where(eq(s.contractServices.id, lineId)).returning();
    await audit(app.db, req, { action: 'update', entityType: 'contract', entityId: id, summary: `Service line ${lineId} updated`, changes: diff(before, data) });
    return row;
  });
  app.delete('/contracts/:id/services/:serviceLineId', { config: { perm: 'contracts.write' } }, async (req) => {
    await app.db
      .delete(s.contractServices)
      .where(and(eq(s.contractServices.id, idOf(req, 'serviceLineId')), eq(s.contractServices.contractId, idOf(req))));
    return { ok: true };
  });
}

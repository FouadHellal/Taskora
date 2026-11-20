import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { contractBlockSchema, contractRateSchema, contractSchema, contractServiceSchema, formatNumber } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, notFound, inUse } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { countAll, intParam, nextSequence, orderFrom, paginated, parseList, searchAny, whereAll } from '../../lib/query.js';
import { validateCustomFields } from '../../lib/custom-fields.js';
import { getSystemSettings } from '../../lib/settings.js';
import type { Tx } from '../../db/client.js';

async function clearOtherDefaults(tx: Tx, companyId: number, keepId: number) {
  await tx.update(s.contracts).set({ isDefault: false }).where(and(eq(s.contracts.companyId, companyId), ne(s.contracts.id, keepId)));
}

/** Usage and financial position of a contract. */
async function contractUsage(db: Tx, id: number) {
  const [usage] = await db
    .execute<{ minutes: number; billableMinutes: number; coveredMinutes: number; billableAmount: number; tickets: number; openTickets: number }>(
      sql`select
        coalesce(sum(te.duration_minutes),0)::int as minutes,
        coalesce(sum(te.duration_minutes) filter (where te.billable),0)::int as "billableMinutes",
        coalesce(sum(te.duration_minutes) filter (where te.contract_covered),0)::int as "coveredMinutes",
        coalesce(sum(te.duration_minutes * coalesce(te.hourly_rate,0) / 60.0) filter (where te.billable and not te.contract_covered),0)::float as "billableAmount",
        (select count(*) from tickets t where t.contract_id = ${id})::int as tickets,
        (select count(*) from tickets t join ticket_statuses st on st.id = t.status_id where t.contract_id = ${id} and st.category not in ('resolved','closed'))::int as "openTickets"
      from time_entries te where te.contract_id = ${id}`,
    )
    .then((r) => r.rows);
  const [blocks] = await db
    .execute<{ purchasedHours: number }>(sql`select coalesce(sum(hours),0)::float as "purchasedHours" from contract_blocks where contract_id = ${id}`)
    .then((r) => r.rows);
  const [svc] = await db
    .execute<{ recurring: number }>(sql`select coalesce(sum(quantity * unit_price),0)::float as recurring from contract_services where contract_id = ${id}`)
    .then((r) => r.rows);
  const usedHours = (usage?.coveredMinutes ?? 0) / 60;
  return {
    ...usage,
    purchasedHours: blocks?.purchasedHours ?? 0,
    usedHours: Math.round(usedHours * 100) / 100,
    remainingHours: Math.round(((blocks?.purchasedHours ?? 0) - usedHours) * 100) / 100,
    recurringServicesAmount: svc?.recurring ?? 0,
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
    const usedMinutes = sql<number>`(select coalesce(sum(te.duration_minutes),0)::int from time_entries te where te.contract_id = ${s.contracts.id})`;
    const purchasedHours = sql<number>`(select coalesce(sum(b.hours),0)::float from contract_blocks b where b.contract_id = ${s.contracts.id})`;
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
        usedMinutes,
        purchasedHours,
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
    return paginated(rows, n, q);
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
    const [rates, blocks, services] = await Promise.all([
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
        })
        .from(s.contractServices)
        .innerJoin(s.services, eq(s.services.id, s.contractServices.serviceId))
        .where(eq(s.contractServices.contractId, id))
        .orderBy(asc(s.services.name)),
    ]);
    return {
      ...row.contract,
      companyName: row.companyName,
      slaName: row.slaName,
      contactName: row.contactName,
      rates,
      blocks,
      services,
      usage: await contractUsage(app.db, id),
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
      await audit(tx, req, { action: 'update', entityType: 'contract', entityId: id, changes: diff(before, data) });
      return row;
    });
  });

  app.delete('/contracts/:id', { config: { perm: 'contracts.write', forceDelete: { table: 'contracts' } } }, async (req) => {
    const id = idOf(req);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.timeEntries).where(eq(s.timeEntries.contractId, id))) as [{ n: number }];
    if (n > 0) throw inUse('Time has been logged against this contract. Set its status to cancelled instead.');
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
      await audit(tx, req, { action: 'update', entityType: 'contract', entityId: id, summary: 'Rates updated', changes: { rates } });
    });
    return { ok: true };
  });

  app.post('/contracts/:id/blocks', { config: { perm: 'contracts.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = contractBlockSchema.parse(req.body);
    const [row] = await app.db.insert(s.contractBlocks).values({ ...input, contractId: id }).returning();
    await audit(app.db, req, { action: 'update', entityType: 'contract', entityId: id, summary: `Block of ${input.hours} h added` });
    return reply.status(201).send(row);
  });
  app.delete('/contracts/:id/blocks/:blockId', { config: { perm: 'contracts.write' } }, async (req) => {
    await app.db.delete(s.contractBlocks).where(and(eq(s.contractBlocks.id, idOf(req, 'blockId')), eq(s.contractBlocks.contractId, idOf(req))));
    return { ok: true };
  });

  app.post('/contracts/:id/services', { config: { perm: 'contracts.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = contractServiceSchema.parse(req.body);
    const [svc] = await app.db.select().from(s.services).where(eq(s.services.id, input.serviceId));
    if (!svc) throw badRequest('Unknown service');
    const [row] = await app.db
      .insert(s.contractServices)
      .values({ contractId: id, serviceId: input.serviceId, quantity: input.quantity, unitPrice: input.unitPrice ?? svc.unitPrice, startDate: input.startDate })
      .returning();
    await audit(app.db, req, { action: 'update', entityType: 'contract', entityId: id, summary: `Service ${svc.name} added` });
    return reply.status(201).send(row);
  });
  app.patch('/contracts/:id/services/:serviceLineId', { config: { perm: 'contracts.write' } }, async (req) => {
    const input = contractServiceSchema.partial().parse(req.body);
    const [row] = await app.db
      .update(s.contractServices)
      .set({ ...(input.quantity !== undefined ? { quantity: input.quantity } : {}), ...(input.unitPrice != null ? { unitPrice: input.unitPrice } : {}) })
      .where(and(eq(s.contractServices.id, idOf(req, 'serviceLineId')), eq(s.contractServices.contractId, idOf(req))))
      .returning();
    return row;
  });
  app.delete('/contracts/:id/services/:serviceLineId', { config: { perm: 'contracts.write' } }, async (req) => {
    await app.db
      .delete(s.contractServices)
      .where(and(eq(s.contractServices.id, idOf(req, 'serviceLineId')), eq(s.contractServices.contractId, idOf(req))));
    return { ok: true };
  });
}

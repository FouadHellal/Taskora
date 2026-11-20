import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { ciRelationSchema, ciSchema, ciSoftwareSchema, formatNumber } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { boolParam, countAll, idList, intParam, nextSequence, orderFrom, paginated, parseList, searchAny, whereAll } from '../../lib/query.js';
import { validateCustomFields } from '../../lib/custom-fields.js';
import { currentUser } from '../../lib/context.js';
import { getSystemSettings } from '../../lib/settings.js';
import type { Tx } from '../../db/client.js';
import { toCsv } from '../tickets/routes.js';

async function assertBelongs(db: Tx, companyId: number, contactId?: number | null, locationId?: number | null) {
  if (contactId) {
    const [c] = await db.select({ companyId: s.contacts.companyId }).from(s.contacts).where(eq(s.contacts.id, contactId));
    if (!c || c.companyId !== companyId) throw badRequest('The contact belongs to another company', { fields: { contactId: 'Contact belongs to another company' } });
  }
  if (locationId) {
    const [l] = await db.select({ companyId: s.locations.companyId }).from(s.locations).where(eq(s.locations.id, locationId));
    if (!l || l.companyId !== companyId) throw badRequest('The location belongs to another company', { fields: { locationId: 'Location belongs to another company' } });
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export async function cmdbRoutes(app: FastifyInstance) {
  const listQuery = async (query: Record<string, unknown>, limit?: number) => {
    const q = parseList(query);
    const contactName = sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`;
    const warranty = q.warranty ? String(q.warranty) : undefined;
    const where = whereAll(
      idList(q.companyId).length ? inArray(s.configurationItems.companyId, idList(q.companyId)) : undefined,
      intParam(q.contactId) ? eq(s.configurationItems.contactId, intParam(q.contactId)!) : undefined,
      idList(q.ciTypeId).length ? inArray(s.configurationItems.ciTypeId, idList(q.ciTypeId)) : undefined,
      q.category ? inArray(s.ciTypes.category, String(q.category).split(',')) : undefined,
      q.lifecycleStatus ? inArray(s.configurationItems.lifecycleStatus, String(q.lifecycleStatus).split(',')) : undefined,
      q.source ? eq(s.configurationItems.source, String(q.source)) : undefined,
      warranty === 'expired' ? sql`${s.configurationItems.warrantyExpiresAt} < ${today()}` : undefined,
      warranty === 'expiring' ? sql`${s.configurationItems.warrantyExpiresAt} between ${today()} and (current_date + 90)` : undefined,
      boolParam(q.attention)
        ? sql`exists (select 1 from action1_endpoints e where e.configuration_item_id = ${s.configurationItems.id}
                and (e.reboot_required or coalesce(e.missing_critical_updates,0) > 0 or e.agent_status = 'Disconnected'))`
        : undefined,
      searchAny(q.q, [
        s.configurationItems.name,
        s.configurationItems.ciNumber,
        s.configurationItems.serialNumber,
        s.configurationItems.hostname,
        s.configurationItems.ipAddress,
        s.configurationItems.assetTag,
        s.configurationItems.model,
        s.companies.name,
        contactName,
      ]),
    );
    const pageSize = limit ?? q.pageSize;
    const rows = await app.db
      .select({
        id: s.configurationItems.id,
        ciNumber: s.configurationItems.ciNumber,
        name: s.configurationItems.name,
        ciTypeId: s.configurationItems.ciTypeId,
        ciTypeName: s.ciTypes.name,
        ciCategory: s.ciTypes.category,
        companyId: s.configurationItems.companyId,
        companyName: s.companies.name,
        contactId: s.configurationItems.contactId,
        contactName,
        manufacturer: s.configurationItems.manufacturer,
        model: s.configurationItems.model,
        serialNumber: s.configurationItems.serialNumber,
        hostname: s.configurationItems.hostname,
        osName: s.configurationItems.osName,
        ipAddress: s.configurationItems.ipAddress,
        lifecycleStatus: s.configurationItems.lifecycleStatus,
        warrantyExpiresAt: s.configurationItems.warrantyExpiresAt,
        lastSeenAt: s.configurationItems.lastSeenAt,
        source: s.configurationItems.source,
        agentStatus: sql<string | null>`(select e.agent_status from action1_endpoints e where e.configuration_item_id = ${s.configurationItems.id})`,
        rebootRequired: sql<boolean | null>`(select e.reboot_required from action1_endpoints e where e.configuration_item_id = ${s.configurationItems.id})`,
        missingCriticalUpdates: sql<number | null>`(select e.missing_critical_updates from action1_endpoints e where e.configuration_item_id = ${s.configurationItems.id})`,
        openTickets: sql<number>`(select count(*)::int from tickets t join ticket_statuses st on st.id = t.status_id where t.configuration_item_id = ${s.configurationItems.id} and st.category not in ('resolved','closed'))`,
      })
      .from(s.configurationItems)
      .innerJoin(s.companies, eq(s.companies.id, s.configurationItems.companyId))
      .innerJoin(s.ciTypes, eq(s.ciTypes.id, s.configurationItems.ciTypeId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.configurationItems.contactId))
      .where(where)
      .orderBy(
        ...(q.sort
          ? orderFrom(
              q.sort,
              q.order,
              {
                name: s.configurationItems.name,
                ciNumber: s.configurationItems.id,
                type: s.ciTypes.name,
                company: s.companies.name,
                lastSeenAt: s.configurationItems.lastSeenAt,
                warrantyExpiresAt: s.configurationItems.warrantyExpiresAt,
                lifecycleStatus: s.configurationItems.lifecycleStatus,
              },
              s.configurationItems.name,
            )
          : [asc(s.configurationItems.name)]),
      )
      .limit(pageSize)
      .offset((q.page - 1) * pageSize);
    const [{ n }] = (await app.db
      .select({ n: countAll })
      .from(s.configurationItems)
      .innerJoin(s.companies, eq(s.companies.id, s.configurationItems.companyId))
      .innerJoin(s.ciTypes, eq(s.ciTypes.id, s.configurationItems.ciTypeId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.configurationItems.contactId))
      .where(where)) as [{ n: number }];
    return paginated(rows, n, q);
  };

  app.get('/configuration-items', { config: { perm: 'cis.read' } }, async (req) => listQuery(req.query as Record<string, unknown>));

  app.get('/configuration-items/export.csv', { config: { perm: 'cis.read' } }, async (req, reply) => {
    const result = await listQuery({ ...(req.query as object), page: 1, pageSize: 500 }, 20000);
    const csv = toCsv(result.data, [
      ['ciNumber', 'CI'],
      ['name', 'Name'],
      ['ciTypeName', 'Type'],
      ['companyName', 'Company'],
      ['contactName', 'Assigned contact'],
      ['manufacturer', 'Manufacturer'],
      ['model', 'Model'],
      ['serialNumber', 'Serial number'],
      ['hostname', 'Hostname'],
      ['osName', 'Operating system'],
      ['ipAddress', 'IP address'],
      ['lifecycleStatus', 'Lifecycle'],
      ['warrantyExpiresAt', 'Warranty expires'],
      ['lastSeenAt', 'Last seen'],
      ['source', 'Source'],
    ]);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="configuration-items.csv"').send(csv);
  });

  app.get('/configuration-items/:id', { config: { perm: 'cis.read' } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db
      .select({
        ci: s.configurationItems,
        ciTypeName: s.ciTypes.name,
        ciCategory: s.ciTypes.category,
        companyName: s.companies.name,
        contactName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
        contactEmail: s.contacts.email,
        contactPhone: s.contacts.phone,
        contactTitle: s.contacts.title,
        locationName: s.locations.name,
        productName: s.products.name,
      })
      .from(s.configurationItems)
      .innerJoin(s.ciTypes, eq(s.ciTypes.id, s.configurationItems.ciTypeId))
      .innerJoin(s.companies, eq(s.companies.id, s.configurationItems.companyId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.configurationItems.contactId))
      .leftJoin(s.locations, eq(s.locations.id, s.configurationItems.locationId))
      .leftJoin(s.products, eq(s.products.id, s.configurationItems.productId))
      .where(eq(s.configurationItems.id, id));
    if (!row) throw notFound('Configuration item');
    const { ci, ...names } = row;
    const [stats] = await app.db
      .execute<{ openTickets: number; totalTickets: number; minutes: number }>(
        sql`select
          (select count(*) from tickets t join ticket_statuses st on st.id = t.status_id where t.configuration_item_id = ${id} and st.category not in ('resolved','closed'))::int as "openTickets",
          (select count(*) from tickets t where t.configuration_item_id = ${id})::int as "totalTickets",
          (select coalesce(sum(te.duration_minutes),0) from time_entries te join tickets t on t.id = te.ticket_id where t.configuration_item_id = ${id})::int as minutes`,
      )
      .then((r) => r.rows);
    return { ...ci, ...names, stats };
  });

  app.post('/configuration-items', { config: { perm: 'cis.write' } }, async (req, reply) => {
    const input = ciSchema.parse(req.body);
    const row = await app.db.transaction(async (tx) => {
      await assertBelongs(tx, input.companyId, input.contactId, input.locationId);
      const settings = await getSystemSettings(tx);
      const customFields = await validateCustomFields(tx, 'configuration_item', input.customFields);
      const [r] = await tx
        .insert(s.configurationItems)
        .values({
          ...input,
          customFields,
          ciNumber: formatNumber(settings.ciPrefix, await nextSequence(tx, 'ci')),
          source: 'manual',
          createdById: currentUser(req).id,
        })
        .returning();
      await audit(tx, req, { action: 'create', entityType: 'configuration_item', entityId: r!.id, summary: `${r!.ciNumber} ${r!.name}` });
      return r!;
    });
    return reply.status(201).send(row);
  });

  app.patch('/configuration-items/:id', { config: { perm: 'cis.write' } }, async (req) => {
    const id = idOf(req);
    const input = ciSchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    return app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s.configurationItems).where(eq(s.configurationItems.id, id));
      if (!before) throw notFound('Configuration item');
      const data = Object.fromEntries(Object.entries(input).filter(([k]) => k in body)) as Partial<typeof before>;
      if ('customFields' in body) data.customFields = await validateCustomFields(tx, 'configuration_item', input.customFields, before.customFields);
      const companyId = data.companyId ?? before.companyId;
      if (data.companyId && data.companyId !== before.companyId) {
        // Moving a device between companies clears links that belong to the old one.
        if (!('contactId' in data)) data.contactId = null;
        if (!('locationId' in data)) data.locationId = null;
      }
      await assertBelongs(tx, companyId, data.contactId, data.locationId);
      const [row] = await tx.update(s.configurationItems).set(data).where(eq(s.configurationItems.id, id)).returning();
      await audit(tx, req, { action: 'update', entityType: 'configuration_item', entityId: id, summary: row!.name, changes: diff(before, data) });
      return row;
    });
  });

  app.delete('/configuration-items/:id', { config: { perm: 'cis.delete', forceDelete: { table: 'configuration_items' } } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.delete(s.configurationItems).where(eq(s.configurationItems.id, id)).returning();
    if (!row) throw notFound('Configuration item');
    await audit(app.db, req, { action: 'delete', entityType: 'configuration_item', entityId: id, summary: `${row.ciNumber} ${row.name}` });
    return { ok: true };
  });

  /* ------------------------------------------------------------ relations */

  app.get('/configuration-items/:id/relations', { config: { perm: 'cis.read' } }, async (req) => {
    const id = idOf(req);
    const rows = await app.db.execute(sql`
      select r.id, r.type, case when r.ci_id = ${id} then 'outgoing' else 'incoming' end as direction,
             c.id as "ciId", c.ci_number as "ciNumber", c.name, t.name as "ciTypeName", c.lifecycle_status as "lifecycleStatus"
      from ci_relations r
      join configuration_items c on c.id = case when r.ci_id = ${id} then r.related_ci_id else r.ci_id end
      join ci_types t on t.id = c.ci_type_id
      where r.ci_id = ${id} or r.related_ci_id = ${id}
      order by c.name`);
    return { data: rows.rows };
  });

  app.post('/configuration-items/:id/relations', { config: { perm: 'cis.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = ciRelationSchema.parse(req.body);
    if (input.relatedCiId === id) throw badRequest('A configuration item cannot be related to itself');
    const cis = await app.db
      .select({ id: s.configurationItems.id, companyId: s.configurationItems.companyId })
      .from(s.configurationItems)
      .where(inArray(s.configurationItems.id, [id, input.relatedCiId]));
    if (cis.length !== 2) throw notFound('Configuration item');
    const [row] = await app.db.insert(s.ciRelations).values({ ciId: id, ...input }).onConflictDoNothing().returning();
    await audit(app.db, req, { action: 'update', entityType: 'configuration_item', entityId: id, summary: `Related to CI ${input.relatedCiId} (${input.type})` });
    return reply.status(201).send(row ?? { ok: true });
  });

  app.delete('/configuration-items/:id/relations/:relationId', { config: { perm: 'cis.write' } }, async (req) => {
    const id = idOf(req);
    await app.db
      .delete(s.ciRelations)
      .where(and(eq(s.ciRelations.id, idOf(req, 'relationId')), or(eq(s.ciRelations.ciId, id), eq(s.ciRelations.relatedCiId, id))));
    return { ok: true };
  });

  /* ------------------------------------------------------------- software */

  app.get('/configuration-items/:id/software', { config: { perm: 'cis.read' } }, async (req) => {
    const rows = await app.db.select().from(s.ciSoftware).where(eq(s.ciSoftware.ciId, idOf(req))).orderBy(asc(s.ciSoftware.name));
    return { data: rows };
  });
  app.post('/configuration-items/:id/software', { config: { perm: 'cis.write' } }, async (req, reply) => {
    const input = ciSoftwareSchema.parse(req.body);
    const [row] = await app.db.insert(s.ciSoftware).values({ ...input, ciId: idOf(req) }).returning();
    return reply.status(201).send(row);
  });
  app.delete('/configuration-items/:id/software/:softwareId', { config: { perm: 'cis.write' } }, async (req) => {
    await app.db.delete(s.ciSoftware).where(and(eq(s.ciSoftware.id, idOf(req, 'softwareId')), eq(s.ciSoftware.ciId, idOf(req))));
    return { ok: true };
  });

  /** Software inventory across all CIs, grouped by title. */
  app.get('/software', { config: { perm: 'cis.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(searchAny(q.q, [s.ciSoftware.name, s.ciSoftware.publisher]));
    const rows = await app.db
      .select({
        name: s.ciSoftware.name,
        publisher: sql<string | null>`max(${s.ciSoftware.publisher})`,
        versions: sql<string[]>`array_remove(array_agg(distinct ${s.ciSoftware.version}), null)`,
        installs: sql<number>`count(*)::int`,
        companies: sql<number>`count(distinct ${s.configurationItems.companyId})::int`,
      })
      .from(s.ciSoftware)
      .innerJoin(s.configurationItems, eq(s.configurationItems.id, s.ciSoftware.ciId))
      .where(where)
      .groupBy(s.ciSoftware.name)
      .orderBy(desc(sql`count(*)`))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: sql<number>`count(distinct ${s.ciSoftware.name})::int` }).from(s.ciSoftware).where(where)) as [{ n: number }];
    return paginated(rows, n, q);
  });

  /** Ticket history of a device (used on the CI workspace). */
  app.get('/configuration-items/:id/activity', { config: { perm: 'cis.read' } }, async (req) => {
    const id = idOf(req);
    const rows = await app.db.execute(sql`
      select * from (
        select 'audit' as kind, a.id::int, a.action as subtype, coalesce(a.summary, a.action) as title, a.changes::text as body, a.at,
               u.first_name || ' ' || u.last_name as actor
        from audit_logs a left join users u on u.id = a.user_id
        where a.entity_type = 'configuration_item' and a.entity_id = ${String(id)}
        union all
        select 'ticket' as kind, t.id, 'ticket' as subtype, t.ticket_number || ' ' || t.title as title, null as body, t.created_at as at,
               u.first_name || ' ' || u.last_name as actor
        from tickets t left join users u on u.id = t.created_by_id
        where t.configuration_item_id = ${id}
      ) x order by at desc limit 100`);
    return { data: rows.rows };
  });
}

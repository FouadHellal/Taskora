import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { activitySchema, companySchema, contactSchema, locationSchema, opportunitySchema } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, notFound, inUse } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { boolParam, countAll, intParam, orderFrom, paginated, parseList, searchAny, whereAll } from '../../lib/query.js';
import { validateCustomFields } from '../../lib/custom-fields.js';
import { currentUser } from '../../lib/context.js';
import { emitEvent } from '../../lib/webhooks.js';
import type { Tx } from '../../db/client.js';

const openTicketCond = sql`${s.tickets.statusId} in (select id from ticket_statuses where category not in ('resolved','closed'))`;

async function assertContactInCompany(db: Tx, contactId: number | null | undefined, companyId: number) {
  if (!contactId) return;
  const [c] = await db.select({ companyId: s.contacts.companyId }).from(s.contacts).where(eq(s.contacts.id, contactId));
  if (!c || c.companyId !== companyId) throw badRequest('The contact does not belong to this company', { fields: { primaryContactId: 'Contact belongs to another company' } });
}

/** An e-mail domain identifies one company only. */
async function assertDomainsFree(tx: Tx, domains: string[], companyId: number | null) {
  if (!domains.length) return;
  const [taken] = await tx
    .select({ name: s.companies.name, domains: s.companies.emailDomains })
    .from(s.companies)
    .where(and(sql`${s.companies.emailDomains} && ${sql`array[${sql.join(domains.map((d) => sql`${d}`), sql`, `)}]::text[]`}`, companyId ? ne(s.companies.id, companyId) : undefined))
    .limit(1);
  if (taken) {
    const d = domains.find((x) => taken.domains.includes(x));
    throw badRequest(`${d} already belongs to ${taken.name}`, { fields: { emailDomains: `${d} already belongs to ${taken.name}` } });
  }
}

export async function crmRoutes(app: FastifyInstance) {
  /* ============================== companies ============================== */

  const manager = alias(s.users, 'manager');

  app.get('/companies', { config: { perm: 'companies.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(
      searchAny(q.q, [s.companies.name, s.companies.accountNumber, s.companies.phone, s.companies.city, s.companies.website]),
      boolParam(q.active) !== undefined ? eq(s.companies.isActive, boolParam(q.active)!) : undefined,
      q.type ? eq(s.companies.type, String(q.type)) : undefined,
      intParam(q.accountManagerId) ? eq(s.companies.accountManagerId, intParam(q.accountManagerId)!) : undefined,
    );
    const openTickets = sql<number>`(select count(*)::int from tickets t where t.company_id = ${s.companies.id} and t.status_id in (select id from ticket_statuses where category not in ('resolved','closed')))`;
    const ciCount = sql<number>`(select count(*)::int from configuration_items c where c.company_id = ${s.companies.id} and c.lifecycle_status = 'active')`;
    const contactCount = sql<number>`(select count(*)::int from contacts c where c.company_id = ${s.companies.id} and c.is_active)`;
    const rows = await app.db
      .select({
        id: s.companies.id,
        name: s.companies.name,
        accountNumber: s.companies.accountNumber,
        type: s.companies.type,
        isActive: s.companies.isActive,
        phone: s.companies.phone,
        website: s.companies.website,
        city: s.companies.city,
        country: s.companies.country,
        industry: s.companies.industry,
        accountManagerId: s.companies.accountManagerId,
        accountManagerName: sql<string | null>`${manager.firstName} || ' ' || ${manager.lastName}`,
        logoUpdatedAt: s.companies.logoUpdatedAt,
        openTickets,
        ciCount,
        contactCount,
        createdAt: s.companies.createdAt,
      })
      .from(s.companies)
      .leftJoin(manager, eq(manager.id, s.companies.accountManagerId))
      .where(where)
      .orderBy(
        ...(q.sort
          ? orderFrom(q.sort, q.order, { name: s.companies.name, type: s.companies.type, city: s.companies.city, createdAt: s.companies.createdAt, openTickets, ciCount }, s.companies.name)
          : [asc(s.companies.name)]),
      )
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.companies).where(where)) as [{ n: number }];
    return paginated(rows, n, q);
  });

  app.get('/companies/:id', { config: { perm: 'companies.read' } }, async (req) => {
    const id = idOf(req);
    const parent = alias(s.companies, 'parent');
    const primary = alias(s.contacts, 'primary_contact');
    const [row] = await app.db
      .select({
        company: s.companies,
        accountManagerName: sql<string | null>`${manager.firstName} || ' ' || ${manager.lastName}`,
        parentCompanyName: parent.name,
        primaryContactName: sql<string | null>`${primary.firstName} || ' ' || ${primary.lastName}`,
        primaryContactEmail: primary.email,
        primaryContactPhone: primary.phone,
        defaultSlaName: s.slaPolicies.name,
      })
      .from(s.companies)
      .leftJoin(manager, eq(manager.id, s.companies.accountManagerId))
      .leftJoin(parent, eq(parent.id, s.companies.parentCompanyId))
      .leftJoin(primary, eq(primary.id, s.companies.primaryContactId))
      .leftJoin(s.slaPolicies, eq(s.slaPolicies.id, s.companies.defaultSlaId))
      .where(eq(s.companies.id, id));
    if (!row) throw notFound('Company');
    return {
      ...row.company,
      accountManagerName: row.accountManagerName,
      parentCompanyName: row.parentCompanyName,
      primaryContactName: row.primaryContactName,
      primaryContactEmail: row.primaryContactEmail,
      primaryContactPhone: row.primaryContactPhone,
      defaultSlaName: row.defaultSlaName,
    };
  });

  /** Operational summary shown at the top of the company workspace. */
  app.get('/companies/:id/summary', { config: { perm: 'companies.read' } }, async (req) => {
    const id = idOf(req);
    const db = app.db;
    const [tickets] = await db.execute<{ open: number; critical: number; unassigned: number; breached: number; waiting: number }>(sql`
      select
        count(*) filter (where st.category not in ('resolved','closed'))::int as open,
        count(*) filter (where st.category not in ('resolved','closed') and p.level = 1)::int as critical,
        count(*) filter (where st.category not in ('resolved','closed') and t.assigned_user_id is null)::int as unassigned,
        count(*) filter (where st.category not in ('resolved','closed') and (t.first_response_breached or t.resolution_breached))::int as breached,
        count(*) filter (where st.category = 'waiting')::int as waiting
      from tickets t
      join ticket_statuses st on st.id = t.status_id
      join ticket_priorities p on p.id = t.priority_id
      where t.company_id = ${id}`).then((r) => r.rows);
    const [cis] = await db.execute<{ active: number; total: number; managed: number; attention: number }>(sql`
      select
        count(*) filter (where c.lifecycle_status = 'active')::int as active,
        count(*)::int as total,
        count(e.id)::int as managed,
        count(e.id) filter (where e.reboot_required or coalesce(e.missing_critical_updates,0) > 0 or e.agent_status = 'Disconnected')::int as attention
      from configuration_items c
      left join action1_endpoints e on e.configuration_item_id = c.id
      where c.company_id = ${id}`).then((r) => r.rows);
    const contracts = await db
      .select({ id: s.contracts.id, name: s.contracts.name, type: s.contracts.type, status: s.contracts.status, endDate: s.contracts.endDate, isDefault: s.contracts.isDefault })
      .from(s.contracts)
      .where(and(eq(s.contracts.companyId, id), eq(s.contracts.status, 'active')));
    const technicians = await db.execute<{ id: number; name: string; open: number }>(sql`
      select u.id, u.first_name || ' ' || u.last_name as name, count(*)::int as open
      from tickets t join users u on u.id = t.assigned_user_id
      join ticket_statuses st on st.id = t.status_id
      where t.company_id = ${id} and st.category not in ('resolved','closed')
      group by u.id, u.first_name, u.last_name order by open desc limit 8`).then((r) => r.rows);
    const [time] = await db.execute<{ minutes30: number; billable30: number }>(sql`
      select coalesce(sum(duration_minutes),0)::int as minutes30,
             coalesce(sum(duration_minutes - coalesce(covered_minutes, case when contract_covered then duration_minutes else 0 end)) filter (where billable),0)::int as billable30
      from time_entries where company_id = ${id} and started_at > now() - interval '30 days'`).then((r) => r.rows);
    const [counts] = await db.execute<{ contacts: number; locations: number; projects: number }>(sql`
      select (select count(*) from contacts where company_id = ${id} and is_active)::int as contacts,
             (select count(*) from locations where company_id = ${id})::int as locations,
             (select count(*) from projects where company_id = ${id} and status in ('planning','active','on_hold'))::int as projects`).then((r) => r.rows);
    return { tickets, cis, contracts, technicians, time, counts };
  });

  /** Unified activity feed: logged activities + ticket lifecycle events. */
  app.get('/companies/:id/activity', { config: { perm: 'companies.read' } }, async (req) => {
    const id = idOf(req);
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 50), 200);
    const rows = await app.db.execute(sql`
      select * from (
        select 'activity' as kind, a.id, a.type as subtype, a.subject as title, a.body, a.occurred_at as at,
               u.first_name || ' ' || u.last_name as actor, null::int as ticket_id, null::text as ticket_number,
               c.first_name || ' ' || c.last_name as contact_name
        from activities a left join users u on u.id = a.user_id left join contacts c on c.id = a.contact_id
        where a.company_id = ${id}
        union all
        select 'ticket' as kind, e.id, e.type as subtype, t.title, e.data::text as body, e.created_at as at,
               u.first_name || ' ' || u.last_name as actor, t.id as ticket_id, t.ticket_number, null as contact_name
        from ticket_events e join tickets t on t.id = e.ticket_id left join users u on u.id = e.user_id
        where t.company_id = ${id} and e.type in ('created','status_changed','assigned','resolved','note_added')
      ) feed order by at desc limit ${limit}`);
    return { data: rows.rows };
  });

  app.post('/companies', { config: { perm: 'companies.write' } }, async (req, reply) => {
    const input = companySchema.parse(req.body);
    const created = await app.db.transaction(async (tx) => {
      const customFields = await validateCustomFields(tx, 'company', input.customFields);
      await assertDomainsFree(tx, input.emailDomains, null);
      const [row] = await tx
        .insert(s.companies)
        .values({ ...input, primaryContactId: null, customFields, createdById: currentUser(req).id })
        .returning();
      await audit(tx, req, { action: 'create', entityType: 'company', entityId: row!.id, summary: row!.name });
      return row!;
    });
    await emitEvent(app.db, 'company.created', { company: created });
    return reply.status(201).send(created);
  });

  app.patch('/companies/:id', { config: { perm: 'companies.write' } }, async (req) => {
    const id = idOf(req);
    const input = companySchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    return app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s.companies).where(eq(s.companies.id, id));
      if (!before) throw notFound('Company');
      const data = Object.fromEntries(Object.entries(input).filter(([k]) => k in body)) as Partial<typeof before>;
      if ('customFields' in body) data.customFields = await validateCustomFields(tx, 'company', input.customFields, before.customFields);
      if (data.parentCompanyId === id) throw badRequest('A company cannot be its own parent');
      if ('primaryContactId' in data) await assertContactInCompany(tx, data.primaryContactId, id);
      if (data.emailDomains) await assertDomainsFree(tx, data.emailDomains, id);
      const [row] = await tx.update(s.companies).set(data).where(eq(s.companies.id, id)).returning();
      await audit(tx, req, { action: 'update', entityType: 'company', entityId: id, summary: row!.name, changes: diff(before, data) });
      return row;
    });
  });

  app.delete('/companies/:id', { config: { perm: 'companies.delete', forceDelete: { table: 'companies' } } }, async (req) => {
    const id = idOf(req);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.tickets).where(eq(s.tickets.companyId, id))) as [{ n: number }];
    if (n > 0) throw inUse('This company has tickets. Mark it inactive instead of deleting it.');
    const [row] = await app.db.delete(s.companies).where(eq(s.companies.id, id)).returning();
    if (!row) throw notFound('Company');
    await app.db.delete(s.logos).where(and(eq(s.logos.entityType, 'company'), eq(s.logos.entityId, id)));
    await audit(app.db, req, { action: 'delete', entityType: 'company', entityId: id, summary: row.name });
    return { ok: true };
  });

  /* ============================== locations ============================== */

  app.get('/locations', { config: { perm: 'companies.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(
      intParam(q.companyId) ? eq(s.locations.companyId, intParam(q.companyId)!) : undefined,
      searchAny(q.q, [s.locations.name, s.locations.city, s.locations.address1]),
    );
    const rows = await app.db
      .select({ location: s.locations, companyName: s.companies.name })
      .from(s.locations)
      .innerJoin(s.companies, eq(s.companies.id, s.locations.companyId))
      .where(where)
      .orderBy(desc(s.locations.isPrimary), asc(s.locations.name))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.locations).where(where)) as [{ n: number }];
    return paginated(rows.map((r) => ({ ...r.location, companyName: r.companyName })), n, q);
  });

  app.get('/locations/:id', { config: { perm: 'companies.read' } }, async (req) => {
    const [row] = await app.db.select().from(s.locations).where(eq(s.locations.id, idOf(req)));
    if (!row) throw notFound('Location');
    return row;
  });

  app.post('/locations', { config: { perm: 'companies.write' } }, async (req, reply) => {
    const input = locationSchema.parse(req.body);
    const row = await app.db.transaction(async (tx) => {
      if (input.isPrimary) await tx.update(s.locations).set({ isPrimary: false }).where(eq(s.locations.companyId, input.companyId));
      const [r] = await tx.insert(s.locations).values(input).returning();
      await audit(tx, req, { action: 'create', entityType: 'location', entityId: r!.id, summary: r!.name });
      return r!;
    });
    return reply.status(201).send(row);
  });

  app.patch('/locations/:id', { config: { perm: 'companies.write' } }, async (req) => {
    const id = idOf(req);
    const input = locationSchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    return app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s.locations).where(eq(s.locations.id, id));
      if (!before) throw notFound('Location');
      const data = Object.fromEntries(Object.entries(input).filter(([k]) => k in body && k !== 'companyId'));
      if (data.isPrimary) await tx.update(s.locations).set({ isPrimary: false }).where(and(eq(s.locations.companyId, before.companyId), ne(s.locations.id, id)));
      const [row] = await tx.update(s.locations).set(data).where(eq(s.locations.id, id)).returning();
      await audit(tx, req, { action: 'update', entityType: 'location', entityId: id, changes: diff(before, data) });
      return row;
    });
  });

  app.delete('/locations/:id', { config: { perm: 'companies.delete', forceDelete: { table: 'locations' } } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.delete(s.locations).where(eq(s.locations.id, id)).returning();
    if (!row) throw notFound('Location');
    await audit(app.db, req, { action: 'delete', entityType: 'location', entityId: id, summary: row.name });
    return { ok: true };
  });

  /* =============================== contacts ============================== */

  app.get('/contacts', { config: { perm: 'companies.read' } }, async (req) => {
    const q = parseList(req.query);
    const fullName = sql`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`;
    const where = whereAll(
      intParam(q.companyId) ? eq(s.contacts.companyId, intParam(q.companyId)!) : undefined,
      boolParam(q.active) !== undefined ? eq(s.contacts.isActive, boolParam(q.active)!) : undefined,
      searchAny(q.q, [fullName, s.contacts.email, s.contacts.phone, s.contacts.mobile, s.contacts.title, s.companies.name]),
    );
    const openTickets = sql<number>`(select count(*)::int from tickets t where t.contact_id = ${s.contacts.id} and t.status_id in (select id from ticket_statuses where category not in ('resolved','closed')))`;
    const ciCount = sql<number>`(select count(*)::int from configuration_items c where c.contact_id = ${s.contacts.id})`;
    const rows = await app.db
      .select({
        id: s.contacts.id,
        firstName: s.contacts.firstName,
        lastName: s.contacts.lastName,
        title: s.contacts.title,
        department: s.contacts.department,
        email: s.contacts.email,
        phone: s.contacts.phone,
        mobile: s.contacts.mobile,
        isActive: s.contacts.isActive,
        isPrimary: s.contacts.isPrimary,
        companyId: s.contacts.companyId,
        companyName: s.companies.name,
        locationName: s.locations.name,
        openTickets,
        ciCount,
      })
      .from(s.contacts)
      .innerJoin(s.companies, eq(s.companies.id, s.contacts.companyId))
      .leftJoin(s.locations, eq(s.locations.id, s.contacts.locationId))
      .where(where)
      .orderBy(
        ...(q.sort
          ? orderFrom(q.sort, q.order, { name: s.contacts.lastName, company: s.companies.name, email: s.contacts.email, title: s.contacts.title, openTickets }, s.contacts.lastName)
          : [asc(s.contacts.lastName), asc(s.contacts.firstName)]),
      )
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db
      .select({ n: countAll })
      .from(s.contacts)
      .innerJoin(s.companies, eq(s.companies.id, s.contacts.companyId))
      .where(where)) as [{ n: number }];
    return paginated(rows, n, q);
  });

  app.get('/contacts/:id', { config: { perm: 'companies.read' } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db
      .select({ contact: s.contacts, companyName: s.companies.name, companyPhone: s.companies.phone, locationName: s.locations.name })
      .from(s.contacts)
      .innerJoin(s.companies, eq(s.companies.id, s.contacts.companyId))
      .leftJoin(s.locations, eq(s.locations.id, s.contacts.locationId))
      .where(eq(s.contacts.id, id));
    if (!row) throw notFound('Contact');
    return { ...publicContact(row.contact), companyName: row.companyName, companyPhone: row.companyPhone, locationName: row.locationName };
  });

  app.post('/contacts', { config: { perm: 'companies.write' } }, async (req, reply) => {
    const input = contactSchema.parse(req.body);
    const row = await app.db.transaction(async (tx) => {
      if (input.locationId) await assertLocation(tx, input.locationId, input.companyId);
      const customFields = await validateCustomFields(tx, 'contact', input.customFields);
      const [r] = await tx.insert(s.contacts).values({ ...input, customFields }).returning();
      if (input.isPrimary) await setPrimaryContact(tx, r!.companyId, r!.id);
      await audit(tx, req, { action: 'create', entityType: 'contact', entityId: r!.id, summary: `${r!.firstName} ${r!.lastName}` });
      return publicContact(r!);
    });
    await emitEvent(app.db, 'contact.created', { contact: row });
    return reply.status(201).send(row);
  });

  app.patch('/contacts/:id', { config: { perm: 'companies.write' } }, async (req) => {
    const id = idOf(req);
    const input = contactSchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    return app.db.transaction(async (tx) => {
      const [before] = await tx.select().from(s.contacts).where(eq(s.contacts.id, id));
      if (!before) throw notFound('Contact');
      const data = Object.fromEntries(Object.entries(input).filter(([k]) => k in body)) as Partial<typeof before>;
      if ('customFields' in body) data.customFields = await validateCustomFields(tx, 'contact', input.customFields, before.customFields);
      const companyId = data.companyId ?? before.companyId;
      if (data.locationId) await assertLocation(tx, data.locationId, companyId);
      const [row] = await tx.update(s.contacts).set(data).where(eq(s.contacts.id, id)).returning().then((r) => r.map(publicContact));
      if (data.isPrimary) await setPrimaryContact(tx, companyId, id);
      await audit(tx, req, { action: 'update', entityType: 'contact', entityId: id, changes: diff(before, data) });
      return row;
    });
  });

  app.delete('/contacts/:id', { config: { perm: 'companies.delete', forceDelete: { table: 'contacts' } } }, async (req) => {
    const id = idOf(req);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.tickets).where(eq(s.tickets.contactId, id))) as [{ n: number }];
    if (n > 0) throw inUse('This contact is linked to tickets. Mark it inactive instead.');
    const [row] = await app.db.delete(s.contacts).where(eq(s.contacts.id, id)).returning();
    if (!row) throw notFound('Contact');
    await audit(app.db, req, { action: 'delete', entityType: 'contact', entityId: id, summary: `${row.firstName} ${row.lastName}` });
    return { ok: true };
  });

  /* ============================== activities ============================= */

  app.get('/activities', { config: { perm: 'companies.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(
      intParam(q.companyId) ? eq(s.activities.companyId, intParam(q.companyId)!) : undefined,
      intParam(q.contactId) ? eq(s.activities.contactId, intParam(q.contactId)!) : undefined,
    );
    const rows = await app.db
      .select({
        activity: s.activities,
        userName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        contactName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
      })
      .from(s.activities)
      .leftJoin(s.users, eq(s.users.id, s.activities.userId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.activities.contactId))
      .where(where)
      .orderBy(desc(s.activities.occurredAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.activities).where(where)) as [{ n: number }];
    return paginated(rows.map((r) => ({ ...r.activity, userName: r.userName, contactName: r.contactName })), n, q);
  });

  app.post('/activities', { config: { perm: 'companies.write' } }, async (req, reply) => {
    const input = activitySchema.parse(req.body);
    const [row] = await app.db
      .insert(s.activities)
      .values({ ...input, occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(), userId: currentUser(req).id })
      .returning();
    return reply.status(201).send(row);
  });

  app.delete('/activities/:id', { config: { perm: 'companies.write', forceDelete: { table: 'activities' } } }, async (req) => {
    await app.db.delete(s.activities).where(eq(s.activities.id, idOf(req)));
    return { ok: true };
  });

  /* ============================ opportunities ============================ */

  app.get('/opportunities', { config: { perm: 'opportunities.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(
      intParam(q.companyId) ? eq(s.opportunities.companyId, intParam(q.companyId)!) : undefined,
      q.stage ? inArray(s.opportunities.stage, String(q.stage).split(',')) : undefined,
      searchAny(q.q, [s.opportunities.title, s.companies.name]),
    );
    const rows = await app.db
      .select({
        opportunity: s.opportunities,
        companyName: s.companies.name,
        ownerName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
      })
      .from(s.opportunities)
      .innerJoin(s.companies, eq(s.companies.id, s.opportunities.companyId))
      .leftJoin(s.users, eq(s.users.id, s.opportunities.ownerId))
      .where(where)
      .orderBy(...orderFrom(q.sort, q.order, { title: s.opportunities.title, amount: s.opportunities.amount, stage: s.opportunities.stage, expectedCloseDate: s.opportunities.expectedCloseDate }, s.opportunities.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db
      .select({ n: countAll })
      .from(s.opportunities)
      .innerJoin(s.companies, eq(s.companies.id, s.opportunities.companyId))
      .where(where)) as [{ n: number }];
    return paginated(rows.map((r) => ({ ...r.opportunity, companyName: r.companyName, ownerName: r.ownerName })), n, q);
  });

  app.post('/opportunities', { config: { perm: 'opportunities.write' } }, async (req, reply) => {
    const input = opportunitySchema.parse(req.body);
    const [row] = await app.db
      .insert(s.opportunities)
      .values({ ...input, closedAt: ['won', 'lost'].includes(input.stage) ? new Date() : null })
      .returning();
    await audit(app.db, req, { action: 'create', entityType: 'opportunity', entityId: row!.id, summary: row!.title });
    return reply.status(201).send(row);
  });

  app.patch('/opportunities/:id', { config: { perm: 'opportunities.write' } }, async (req) => {
    const id = idOf(req);
    const input = opportunitySchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = Object.fromEntries(Object.entries(input).filter(([k]) => k in body));
    if (data.stage) data.closedAt = ['won', 'lost'].includes(String(data.stage)) ? new Date() : null;
    const [row] = await app.db.update(s.opportunities).set(data).where(eq(s.opportunities.id, id)).returning();
    if (!row) throw notFound('Opportunity');
    await audit(app.db, req, { action: 'update', entityType: 'opportunity', entityId: id, changes: data });
    return row;
  });

  app.delete('/opportunities/:id', { config: { perm: 'opportunities.write', forceDelete: { table: 'opportunities' } } }, async (req) => {
    const id = idOf(req);
    await app.db.delete(s.opportunities).where(eq(s.opportunities.id, id));
    await audit(app.db, req, { action: 'delete', entityType: 'opportunity', entityId: id });
    return { ok: true };
  });
}

async function assertLocation(db: Tx, locationId: number, companyId: number) {
  const [l] = await db.select({ companyId: s.locations.companyId }).from(s.locations).where(eq(s.locations.id, locationId));
  if (!l || l.companyId !== companyId) throw badRequest('The location does not belong to this company', { fields: { locationId: 'Location belongs to another company' } });
}

/** Never expose portal credentials through staff endpoints. */
function publicContact<T extends { portalPasswordHash?: string | null; portalResetTokenHash?: string | null }>(c: T): Omit<T, 'portalPasswordHash' | 'portalResetTokenHash'> & { portalPasswordSet: boolean } {
  const { portalPasswordHash, portalResetTokenHash: _reset, ...rest } = c;
  return { ...rest, portalPasswordSet: !!portalPasswordHash };
}

async function setPrimaryContact(db: Tx, companyId: number, contactId: number) {
  await db.update(s.contacts).set({ isPrimary: false }).where(and(eq(s.contacts.companyId, companyId), ne(s.contacts.id, contactId)));
  await db.update(s.companies).set({ primaryContactId: contactId }).where(eq(s.companies.id, companyId));
}

export { openTicketCond };

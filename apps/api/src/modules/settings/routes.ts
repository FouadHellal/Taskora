import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  billingCodeSchema,
  businessHoursSchema,
  ciTypeSchema,
  customFieldSchema,
  holidaySchema,
  issueTypeSchema,
  kbCategorySchema,
  namedSettingSchema,
  notificationTemplateSchema,
  prioritySchema,
  productSchema,
  queueSchema,
  serviceSchema,
  slaPolicySchema,
  subIssueTypeSchema,
  ticketStatusSchema,
  ticketTemplateSchema,
  workTypeSchema,
} from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { registerCrud, singleDefault } from '../../lib/crud.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { getSystemSettings, saveSystemSettings, systemSettingsSchema } from '../../lib/settings.js';

export async function settingsRoutes(app: FastifyInstance) {
  const W = 'settings.manage' as const;

  registerCrud(app, {
    path: '/settings/ticket-statuses',
    table: s.ticketStatuses,
    entityType: 'ticket_status',
    schema: ticketStatusSchema as never,
    writePerm: W,
    beforeWrite: singleDefault(s.ticketStatuses),
  });
  registerCrud(app, {
    path: '/settings/priorities',
    table: s.ticketPriorities,
    entityType: 'priority',
    schema: prioritySchema as never,
    writePerm: W,
    beforeWrite: singleDefault(s.ticketPriorities),
  });
  registerCrud(app, { path: '/settings/ticket-types', table: s.ticketTypes, entityType: 'ticket_type', schema: namedSettingSchema as never, writePerm: W });
  registerCrud(app, { path: '/settings/ticket-sources', table: s.ticketSources, entityType: 'ticket_source', schema: namedSettingSchema as never, writePerm: W });
  registerCrud(app, { path: '/settings/queues', table: s.queues, entityType: 'queue', schema: queueSchema as never, writePerm: W });
  registerCrud(app, {
    path: '/settings/issue-types',
    table: s.issueTypes,
    entityType: 'issue_type',
    schema: issueTypeSchema as never,
    writePerm: W,
    filters: { ticketTypeId: s.issueTypes.ticketTypeId },
  });
  registerCrud(app, {
    path: '/settings/sub-issue-types',
    table: s.subIssueTypes,
    entityType: 'sub_issue_type',
    schema: subIssueTypeSchema as never,
    writePerm: W,
    filters: { issueTypeId: s.subIssueTypes.issueTypeId },
  });
  registerCrud(app, { path: '/settings/work-types', table: s.workTypes, entityType: 'work_type', schema: workTypeSchema as never, writePerm: W });
  registerCrud(app, { path: '/settings/billing-codes', table: s.billingCodes, entityType: 'billing_code', schema: billingCodeSchema as never, writePerm: W });
  registerCrud(app, { path: '/settings/ci-types', table: s.ciTypes, entityType: 'ci_type', schema: ciTypeSchema as never, writePerm: W });
  registerCrud(app, {
    path: '/settings/custom-fields',
    table: s.customFieldDefinitions,
    entityType: 'custom_field',
    schema: customFieldSchema as never,
    writePerm: W,
    filters: { entity: s.customFieldDefinitions.entity },
  });
  registerCrud(app, {
    path: '/settings/notification-templates',
    table: s.notificationTemplates,
    entityType: 'notification_template',
    schema: notificationTemplateSchema as never,
    writePerm: W,
  });
  registerCrud(app, {
    path: '/settings/ticket-templates',
    table: s.ticketTemplates,
    entityType: 'ticket_template',
    schema: ticketTemplateSchema as never,
    writePerm: 'tickets.write',
    orderBy: [asc(s.ticketTemplates.name)],
  });
  registerCrud(app, {
    path: '/settings/holidays',
    table: s.holidays,
    entityType: 'holiday',
    schema: holidaySchema as never,
    writePerm: W,
    orderBy: [asc(s.holidays.date)],
    filters: { businessHoursId: s.holidays.businessHoursId },
  });
  registerCrud(app, {
    path: '/settings/business-hours',
    table: s.businessHours,
    entityType: 'business_hours',
    schema: businessHoursSchema as never,
    writePerm: W,
    beforeWrite: singleDefault(s.businessHours),
  });
  registerCrud(app, {
    path: '/products',
    table: s.products,
    entityType: 'product',
    schema: productSchema as never,
    readPerm: 'cis.read',
    writePerm: 'cis.write',
    orderBy: [asc(s.products.name)],
  });
  registerCrud(app, {
    path: '/services',
    table: s.services,
    entityType: 'service',
    schema: serviceSchema as never,
    readPerm: 'contracts.read',
    writePerm: 'contracts.write',
    orderBy: [asc(s.services.name)],
  });
  registerCrud(app, {
    path: '/kb/categories',
    table: s.kbCategories,
    entityType: 'kb_category',
    schema: kbCategorySchema as never,
    readPerm: 'kb.read',
    writePerm: 'kb.write',
  });

  /* ---- SLA policies with per-priority targets ---- */

  async function slaWithTargets(ids?: number[]) {
    const policies = await app.db
      .select()
      .from(s.slaPolicies)
      .where(ids ? inArray(s.slaPolicies.id, ids) : undefined)
      .orderBy(asc(s.slaPolicies.name));
    const targets = policies.length
      ? await app.db.select().from(s.slaTargets).where(inArray(s.slaTargets.slaId, policies.map((p) => p.id)))
      : [];
    return policies.map((p) => ({ ...p, targets: targets.filter((t) => t.slaId === p.id) }));
  }

  app.get('/settings/sla-policies', async () => ({ data: await slaWithTargets() }));
  app.get('/settings/sla-policies/:id', async (req) => {
    const [row] = await slaWithTargets([Number((req.params as { id: string }).id)]);
    if (!row) throw notFound('SLA policy');
    return row;
  });

  const saveSla = async (id: number | null, body: unknown, req: FastifyRequest) => {
    const input = slaPolicySchema.parse(body);
    return app.db.transaction(async (tx) => {
      if (input.isDefault) await tx.update(s.slaPolicies).set({ isDefault: false });
      const values = {
        name: input.name,
        description: input.description,
        businessHoursId: input.businessHoursId,
        isDefault: input.isDefault,
        isActive: input.isActive,
      };
      let policyId = id;
      if (policyId) {
        const [u] = await tx.update(s.slaPolicies).set(values).where(eq(s.slaPolicies.id, policyId)).returning();
        if (!u) throw notFound('SLA policy');
        await tx.delete(s.slaTargets).where(eq(s.slaTargets.slaId, policyId));
      } else {
        const [c] = await tx.insert(s.slaPolicies).values(values).returning();
        policyId = c!.id;
      }
      if (input.targets.length) {
        await tx.insert(s.slaTargets).values(input.targets.map((t) => ({ ...t, slaId: policyId! })));
      }
      await audit(tx, req, { action: id ? 'update' : 'create', entityType: 'sla_policy', entityId: policyId, summary: input.name });
      return policyId!;
    });
  };

  app.post('/settings/sla-policies', { config: { perm: W } }, async (req, reply) => {
    const id = await saveSla(null, req.body, req);
    return reply.status(201).send((await slaWithTargets([id]))[0]);
  });
  app.put('/settings/sla-policies/:id', { config: { perm: W } }, async (req) => {
    const id = await saveSla(Number((req.params as { id: string }).id), req.body, req);
    return (await slaWithTargets([id]))[0];
  });
  app.delete('/settings/sla-policies/:id', { config: { perm: W, forceDelete: { table: 'sla_policies', reassign: true } } }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    await app.db.delete(s.slaPolicies).where(eq(s.slaPolicies.id, id));
    await audit(app.db, req, { action: 'delete', entityType: 'sla_policy', entityId: id });
    return { ok: true };
  });

  /* ---- System settings ---- */

  app.get('/settings/system', async () => getSystemSettings(app.db));
  app.put('/settings/system', { config: { perm: W } }, async (req) => {
    // Logo and backup schedule have their own endpoints (and permissions); ignore them here.
    const patch = systemSettingsSchema
      .omit({ logoUpdatedAt: true, autoBackupEnabled: true, autoBackupIntervalHours: true, backupRetention: true })
      .partial()
      .parse(req.body);
    const saved = await saveSystemSettings(app.db, patch);
    await audit(app.db, req, { action: 'update', entityType: 'system_settings', changes: patch });
    return saved;
  });

  /* ---- Lookups: every picklist in one round trip for forms and filters ---- */

  app.get('/lookups', async () => {
    const db = app.db;
    const [statuses, priorities, ticketTypes, sources, queues, issueTypes, subIssueTypes, workTypes, billingCodes, ciTypes, slaPolicies, users, customFields] =
      await Promise.all([
        db.select().from(s.ticketStatuses).orderBy(asc(s.ticketStatuses.sortOrder)),
        db.select().from(s.ticketPriorities).orderBy(asc(s.ticketPriorities.sortOrder)),
        db.select().from(s.ticketTypes).orderBy(asc(s.ticketTypes.sortOrder)),
        db.select().from(s.ticketSources).orderBy(asc(s.ticketSources.sortOrder)),
        db.select().from(s.queues).orderBy(asc(s.queues.sortOrder)),
        db.select().from(s.issueTypes).orderBy(asc(s.issueTypes.sortOrder)),
        db.select().from(s.subIssueTypes).orderBy(asc(s.subIssueTypes.sortOrder)),
        db.select().from(s.workTypes).orderBy(asc(s.workTypes.sortOrder)),
        db.select().from(s.billingCodes).orderBy(asc(s.billingCodes.sortOrder)),
        db.select().from(s.ciTypes).orderBy(asc(s.ciTypes.sortOrder)),
        db.select({ id: s.slaPolicies.id, name: s.slaPolicies.name, isDefault: s.slaPolicies.isDefault, isActive: s.slaPolicies.isActive }).from(s.slaPolicies),
        db
          .select({
            id: s.users.id,
            firstName: s.users.firstName,
            lastName: s.users.lastName,
            email: s.users.email,
            isActive: s.users.isActive,
            isTechnician: s.users.isTechnician,
          })
          .from(s.users)
          .orderBy(asc(s.users.firstName)),
        db.select().from(s.customFieldDefinitions).orderBy(asc(s.customFieldDefinitions.sortOrder)),
      ]);
    return { statuses, priorities, ticketTypes, sources, queues, issueTypes, subIssueTypes, workTypes, billingCodes, ciTypes, slaPolicies, users, customFields };
  });
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

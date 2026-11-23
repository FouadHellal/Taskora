import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { currentUser } from '../../lib/context.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { getSystemSettings } from '../../lib/settings.js';
import { generateReport, isPeriod, lastAutoRun, previousPeriod, publishReport, REPORT_SECTIONS, reportCompanies } from './service.js';

const period = z.string().refine(isPeriod, 'Use YYYY-MM');
const createSchema = z.object({ companyId: z.coerce.number().int().positive(), period, publish: z.boolean().default(false), notify: z.boolean().default(true) });
const allSchema = z.object({ period });
const updateSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  summary: z.string().max(20000).optional(),
  hiddenSections: z.array(z.enum(REPORT_SECTIONS)).optional(),
});
const publishSchema = z.object({ notify: z.boolean().default(true) });

/** Monthly client reports (IT side). Reading needs companies.read, preparing and publishing companies.write. */
export async function clientReportRoutes(app: FastifyInstance) {
  const select = {
    id: s.clientReports.id,
    companyId: s.clientReports.companyId,
    companyName: s.companies.name,
    period: s.clientReports.period,
    title: s.clientReports.title,
    status: s.clientReports.status,
    source: s.clientReports.source,
    publishedAt: s.clientReports.publishedAt,
    emailedAt: s.clientReports.emailedAt,
    createdAt: s.clientReports.createdAt,
    updatedAt: s.clientReports.updatedAt,
    healthScore: sql<number | null>`(${s.clientReports.data}->'health'->>'score')::int`,
    opened: sql<number | null>`(${s.clientReports.data}->'tickets'->>'opened')::int`,
    minutes: sql<number | null>`(${s.clientReports.data}->'work'->>'minutes')::int`,
  };

  app.get('/client-reports', { config: { perm: 'companies.read' } }, async (req) => {
    const q = req.query as { companyId?: string; status?: string; period?: string };
    const settings = await getSystemSettings(app.db);
    const data = await app.db
      .select(select)
      .from(s.clientReports)
      .innerJoin(s.companies, eq(s.companies.id, s.clientReports.companyId))
      .where(
        and(
          q.companyId ? eq(s.clientReports.companyId, Number(q.companyId)) : undefined,
          q.status ? eq(s.clientReports.status, q.status) : undefined,
          q.period ? eq(s.clientReports.period, q.period) : undefined,
        ),
      )
      .orderBy(desc(s.clientReports.period), s.companies.name)
      .limit(1000);
    return {
      data,
      automation: { mode: settings.reportsAutoMode, day: settings.reportsAutoDay, lastRun: await lastAutoRun(app.db) },
      suggestedPeriod: previousPeriod(settings.timezone),
      eligibleCompanies: (await reportCompanies(app.db)).length,
    };
  });

  app.get('/client-reports/:id', { config: { perm: 'companies.read' } }, async (req) => {
    const [row] = await app.db
      .select({ report: s.clientReports, companyName: s.companies.name })
      .from(s.clientReports)
      .innerJoin(s.companies, eq(s.companies.id, s.clientReports.companyId))
      .where(eq(s.clientReports.id, idOf(req)));
    if (!row) throw notFound('Report');
    const settings = await getSystemSettings(app.db);
    return { ...row.report, companyName: row.companyName, currency: settings.currency, showTime: settings.portalShowTime };
  });

  app.post('/client-reports', { config: { perm: 'companies.write' } }, async (req, reply) => {
    const input = createSchema.parse(req.body);
    const [co] = await app.db.select({ id: s.companies.id, name: s.companies.name }).from(s.companies).where(eq(s.companies.id, input.companyId));
    if (!co) throw badRequest('Unknown company');
    const me = currentUser(req);
    const { report, created } = await generateReport(app.db, { companyId: co.id, period: input.period, userId: me.id, source: 'manual' });
    if (!created && report.status === 'published') throw conflict(`The ${input.period} report of ${co.name} is already published — open it to refresh or unpublish it`);
    const final = input.publish ? await publishReport(app.db, report.id, me.id, input.notify) : report;
    await audit(app.db, req, { action: 'create', entityType: 'client_report', entityId: report.id, summary: `Report ${input.period} for ${co.name}${input.publish ? ' published' : ''}` });
    return reply.status(created ? 201 : 200).send(final);
  });

  /** Prepares drafts for every company with an active contract or portal users (existing reports are kept). */
  app.post('/client-reports/generate-all', { config: { perm: 'companies.write' } }, async (req) => {
    const input = allSchema.parse(req.body);
    const me = currentUser(req);
    let created = 0;
    let refreshed = 0;
    for (const co of await reportCompanies(app.db)) {
      const r = await generateReport(app.db, { companyId: co.id, period: input.period, userId: me.id, source: 'manual' });
      if (r.created) created++;
      else if (r.report.status === 'draft') refreshed++;
    }
    await audit(app.db, req, { action: 'create', entityType: 'client_report', summary: `Reports ${input.period} prepared (${created} new, ${refreshed} refreshed)` });
    return { created, refreshed };
  });

  app.patch('/client-reports/:id', { config: { perm: 'companies.write' } }, async (req) => {
    const input = updateSchema.parse(req.body);
    const [row] = await app.db
      .update(s.clientReports)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(s.clientReports.id, idOf(req)))
      .returning();
    if (!row) throw notFound('Report');
    return row;
  });

  app.post('/client-reports/:id/refresh', { config: { perm: 'companies.write' } }, async (req) => {
    const [row] = await app.db.select().from(s.clientReports).where(eq(s.clientReports.id, idOf(req)));
    if (!row) throw notFound('Report');
    const { report } = await generateReport(app.db, { companyId: row.companyId, period: row.period, userId: currentUser(req).id, source: 'manual', refreshPublished: true });
    return report;
  });

  app.post('/client-reports/:id/publish', { config: { perm: 'companies.write' } }, async (req) => {
    const input = publishSchema.parse(req.body ?? {});
    const row = await publishReport(app.db, idOf(req), currentUser(req).id, input.notify);
    if (!row) throw notFound('Report');
    await audit(app.db, req, { action: 'update', entityType: 'client_report', entityId: row.id, summary: `Report ${row.period} published` });
    return row;
  });

  app.post('/client-reports/:id/unpublish', { config: { perm: 'companies.write' } }, async (req) => {
    const [row] = await app.db.update(s.clientReports).set({ status: 'draft', updatedAt: new Date() }).where(eq(s.clientReports.id, idOf(req))).returning();
    if (!row) throw notFound('Report');
    await audit(app.db, req, { action: 'update', entityType: 'client_report', entityId: row.id, summary: `Report ${row.period} unpublished` });
    return row;
  });

  app.delete('/client-reports/:id', { config: { perm: 'companies.write' } }, async (req) => {
    const [row] = await app.db.delete(s.clientReports).where(eq(s.clientReports.id, idOf(req))).returning();
    if (!row) throw notFound('Report');
    await audit(app.db, req, { action: 'delete', entityType: 'client_report', entityId: row.id, summary: `Report ${row.period} deleted` });
    return { ok: true };
  });
}

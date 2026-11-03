/**
 * atlas integration routes (docs/integrations/atlas.md).
 *
 * `/integrations/atlas/v1/*` — machine API for atlas, authenticated by a scoped integration
 * token (`config.scope`), rate-limited and size-capped. Session cookies are ignored there.
 * The rest — settings, tokens, review — are normal session routes with RBAC permissions.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ATLAS_EXTERNAL_KEY,
  atlasEntityResolveSchema,
  atlasIncidentEventSchema,
  atlasInventorySyncSchema,
  atlasSettingsSchema,
  INTEGRATION_SCOPES,
  integrationTokenCreateSchema,
} from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { currentUser } from '../../lib/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { intParam } from '../../lib/query.js';
import { runTicketRules } from '../automation/engine.js';
import {
  ATLAS_PROVIDER,
  applyIncidentEvent,
  ciAtlasPanel,
  getAtlasSettings,
  incidentLookup,
  listEntities,
  newIntegrationToken,
  resolveEntity,
  saveAtlasSettings,
  syncInventory,
  ticketAtlasPanel,
  ticketEventsFeed,
  ticketSnapshot,
} from '../../integrations/atlas/service.js';

const PER_MINUTE = { max: 600, timeWindow: '1 minute' };
const keyParam = z.object({ key: z.string().regex(ATLAS_EXTERNAL_KEY, 'external key is <instance>:<incident id>') });

export async function atlasRoutes(app: FastifyInstance) {
  /* ---------------------------------------------------------------- machine API */

  app.get(
    '/integrations/atlas/v1/health',
    { config: { scope: ['atlas.incidents', 'atlas.cmdb'], rateLimit: PER_MINUTE } },
    async (req) => {
      const { settings } = await getAtlasSettings(app.db);
      return {
        ok: true,
        integration: 'atlas',
        apiVersion: 1,
        enabled: settings.enabled,
        companyConfigured: !!settings.companyId,
        autoCreateTickets: settings.autoCreateTickets,
        cmdbMode: settings.cmdbMode,
        scopes: req.integration!.scopes,
      };
    },
  );

  // PUT is the natural verb for this idempotent upsert; POST is accepted with identical
  // semantics because atlas's HTTP client only sends GET and registered POST requests.
  app.route({
    method: ['PUT', 'POST'],
    url: '/integrations/atlas/v1/incidents/:key',
    config: { scope: 'atlas.incidents', rateLimit: PER_MINUTE },
    bodyLimit: 256 * 1024,
    handler: async (req, reply) => {
      const { key } = keyParam.parse(req.params);
      const ev = atlasIncidentEventSchema.parse(req.body);
      if (`${ev.instance}:${ev.incidentId}` !== key) throw badRequest('The URL key does not match the incident in the body');
      const result = await applyIncidentEvent(app.db, ev, req.integration!.name);
      // Workflow rules see atlas tickets like any new ticket (after the commit, loop-safe).
      if (result.createdTicketId) await runTicketRules(app.db, 'ticket.created', result.createdTicketId);
      const { createdTicketId: _ignored, ...body } = result;
      return reply.status(result.created ? 201 : 200).send(body);
    },
  });

  app.get('/integrations/atlas/v1/incidents/:key', { config: { scope: 'atlas.incidents', rateLimit: PER_MINUTE } }, async (req) => {
    const { key } = keyParam.parse(req.params);
    return incidentLookup(app.db, key);
  });

  app.get('/integrations/atlas/v1/ticket-events', { config: { scope: 'atlas.incidents', rateLimit: PER_MINUTE } }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const after = Math.max(0, intParam(q.after) ?? 0);
    const limit = Math.min(200, Math.max(1, intParam(q.limit) ?? 100));
    return ticketEventsFeed(app.db, after, limit);
  });

  app.post(
    '/integrations/atlas/v1/inventory',
    { config: { scope: 'atlas.cmdb', rateLimit: { max: 60, timeWindow: '1 minute' } }, bodyLimit: 2 * 1024 * 1024 },
    async (req) => {
      const body = atlasInventorySyncSchema.parse(req.body);
      return syncInventory(app.db, body, req.integration!.name);
    },
  );

  /* ---------------------------------------------------------------- administration */

  app.get('/integrations/atlas/settings', { config: { perm: 'integrations.read' } }, async () => {
    const { settings, row } = await getAtlasSettings(app.db);
    const tokens = await app.db
      .select({ id: s.integrationTokens.id, name: s.integrationTokens.name, prefix: s.integrationTokens.prefix, scopes: s.integrationTokens.scopes, createdAt: s.integrationTokens.createdAt, lastUsedAt: s.integrationTokens.lastUsedAt, expiresAt: s.integrationTokens.expiresAt, revokedAt: s.integrationTokens.revokedAt })
      .from(s.integrationTokens)
      .orderBy(desc(s.integrationTokens.createdAt));
    const [incidents] = await app.db
      .select({ total: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${s.atlasIncidentLinks.state} <> 'resolved')::int` })
      .from(s.atlasIncidentLinks);
    return {
      settings,
      status: { status: row?.status ?? 'not_configured', lastSuccessAt: row?.lastSuccessAt ?? null, lastSyncAt: row?.lastSyncAt ?? null, lastError: row?.lastError ?? null },
      incidents,
      tokens,
      scopes: INTEGRATION_SCOPES,
    };
  });

  app.put('/integrations/atlas/settings', { config: { perm: 'integrations.manage' } }, async (req) => {
    const settings = atlasSettingsSchema.parse(req.body);
    if (settings.companyId) {
      const [co] = await app.db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.id, settings.companyId));
      if (!co) throw badRequest('Unknown company', { fields: { companyId: 'Unknown company' } });
    }
    const row = await saveAtlasSettings(app.db, settings);
    await audit(app.db, req, { action: 'update', entityType: 'integration', entityId: row.id, summary: 'atlas integration settings saved' });
    return { settings };
  });

  app.get('/integrations/tokens', { config: { perm: 'integrations.manage' } }, async () => {
    const rows = await app.db
      .select({ id: s.integrationTokens.id, name: s.integrationTokens.name, prefix: s.integrationTokens.prefix, scopes: s.integrationTokens.scopes, createdAt: s.integrationTokens.createdAt, lastUsedAt: s.integrationTokens.lastUsedAt, lastUsedIp: s.integrationTokens.lastUsedIp, expiresAt: s.integrationTokens.expiresAt, revokedAt: s.integrationTokens.revokedAt })
      .from(s.integrationTokens)
      .orderBy(desc(s.integrationTokens.createdAt));
    return { data: rows };
  });

  app.post('/integrations/tokens', { config: { perm: 'integrations.manage' } }, async (req, reply) => {
    const user = currentUser(req);
    const input = integrationTokenCreateSchema.parse(req.body);
    const { token, hash, prefix } = newIntegrationToken();
    const [row] = await app.db
      .insert(s.integrationTokens)
      .values({ name: input.name, prefix, tokenHash: hash, scopes: input.scopes, createdById: user.id, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null })
      .returning({ id: s.integrationTokens.id });
    await audit(app.db, req, { action: 'create', entityType: 'integration_token', entityId: row!.id, summary: `Integration token "${input.name}" (${input.scopes.join(', ')}) created` });
    // The only time the token is ever shown.
    return reply.status(201).send({ id: row!.id, token, prefix, scopes: input.scopes });
  });

  app.delete('/integrations/tokens/:id', { config: { perm: 'integrations.manage' } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db
      .update(s.integrationTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.integrationTokens.id, id), sql`${s.integrationTokens.revokedAt} is null`))
      .returning({ name: s.integrationTokens.name });
    if (!row) throw notFound('Active integration token');
    await audit(app.db, req, { action: 'update', entityType: 'integration_token', entityId: id, summary: `Integration token "${row.name}" revoked` });
    return { ok: true };
  });

  app.get('/integrations/atlas/entities', { config: { perm: 'integrations.read' } }, async (req) => {
    const q = req.query as Record<string, unknown>;
    return listEntities(app.db, {
      status: typeof q.status === 'string' && q.status ? q.status.slice(0, 20) : undefined,
      q: typeof q.q === 'string' && q.q ? q.q.slice(0, 100) : undefined,
      page: Math.max(1, intParam(q.page) ?? 1),
      pageSize: Math.min(200, Math.max(1, intParam(q.pageSize) ?? 50)),
    });
  });

  app.post('/integrations/atlas/entities/:id/resolve', { config: { perm: 'integrations.manage' } }, async (req) => {
    const user = currentUser(req);
    const action = atlasEntityResolveSchema.parse(req.body);
    return resolveEntity(app.db, idOf(req), action, user.id);
  });

  app.get('/integrations/atlas/incidents', { config: { perm: 'integrations.read' } }, async (req) => {
    const q = req.query as Record<string, unknown>;
    const open = q.open === 'true';
    const rows = await app.db
      .select()
      .from(s.atlasIncidentLinks)
      .where(open ? sql`${s.atlasIncidentLinks.state} <> 'resolved'` : undefined)
      .orderBy(desc(s.atlasIncidentLinks.updatedAt))
      .limit(Math.min(200, Math.max(1, intParam(q.limit) ?? 100)));
    const data = [];
    for (const r of rows) data.push({ externalKey: r.externalKey, title: r.title, state: r.state, severity: r.severity, persisting: r.persisting, revision: r.revision, lastObservedAt: r.lastObservedAt, resolvedAt: r.resolvedAt, link: r.link, ticket: await ticketSnapshot(app.db, r.ticketId) });
    return { data };
  });

  app.get('/integrations/atlas/runs', { config: { perm: 'integrations.read' } }, async () => {
    const rows = await app.db.select().from(s.syncRuns).where(eq(s.syncRuns.provider, ATLAS_PROVIDER)).orderBy(desc(s.syncRuns.startedAt)).limit(30);
    return { data: rows };
  });

  app.get('/tickets/:id/atlas', { config: { perm: 'tickets.read' } }, async (req) => ticketAtlasPanel(app.db, idOf(req)));
  app.get('/configuration-items/:id/atlas', { config: { perm: 'cis.read' } }, async (req) => ciAtlasPanel(app.db, idOf(req)));
}

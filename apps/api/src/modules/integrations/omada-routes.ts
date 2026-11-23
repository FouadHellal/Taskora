import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { omadaSettingsSchema, omadaSiteMappingSchema } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { encryptJson } from '../../lib/crypto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { boolParam } from '../../lib/query.js';
import { currentUser } from '../../lib/context.js';
import { buildOmadaClient, getOmadaIntegration, OMADA_PROVIDER, OMADA_SYNC_JOB, readOmadaSecrets, readOmadaSettings, runOmadaSync, type OmadaSecrets } from '../../integrations/omada/sync.js';
import { agentState, omadaAgentRoutes } from './omada-agent-routes.js';

const hint = (v?: string | null) => (!v ? null : v.length <= 4 ? '****' : `…${v.slice(-4)}`);

/** TP-Link Omada integration (Administration → Integrations → Omada). */
export async function omadaRoutes(app: FastifyInstance) {
  const db = app.db;
  await omadaAgentRoutes(app);

  async function view() {
    const row = await getOmadaIntegration(db);
    let secrets: OmadaSecrets | null = null;
    let credentialsError: string | null = null;
    try {
      secrets = readOmadaSecrets(app.config, row);
    } catch (err) {
      credentialsError = err instanceof Error ? err.message : 'Stored credentials are unreadable';
    }
    const [counts] = await db
      .select({
        sites: sql<number>`(select count(*)::int from omada_sites)`,
        mappedSites: sql<number>`(select count(*)::int from omada_sites where company_id is not null and enabled)`,
        devices: sql<number>`(select count(*)::int from omada_devices where missing_since is null)`,
        online: sql<number>`(select count(*)::int from omada_devices where missing_since is null and status = 'online')`,
        clients: sql<number>`(select count(*)::int from omada_clients where active)`,
      })
      .from(sql`(select 1) x`);
    const [latestRun] = await db
      .select({ id: s.syncRuns.id, trigger: s.syncRuns.trigger, status: s.syncRuns.status, startedAt: s.syncRuns.startedAt, finishedAt: s.syncRuns.finishedAt, stats: s.syncRuns.stats, error: s.syncRuns.error, log: s.syncRuns.log })
      .from(s.syncRuns)
      .where(eq(s.syncRuns.provider, OMADA_PROVIDER))
      .orderBy(desc(s.syncRuns.startedAt), desc(s.syncRuns.id))
      .limit(1);
    return {
      provider: OMADA_PROVIDER,
      ...readOmadaSettings(row),
      hasCredentials: !!row.secretsEncrypted,
      clientIdHint: hint(secrets?.clientId),
      credentialsError,
      status: row.status,
      lastSyncAt: row.lastSyncAt,
      lastSuccessAt: row.lastSuccessAt,
      lastError: row.lastError,
      nextSyncAt: row.nextSyncAt,
      counts,
      latestRun: latestRun ?? null,
      agent: await agentState(db),
      agentTokens: await db
        .select({ id: s.integrationTokens.id, name: s.integrationTokens.name, prefix: s.integrationTokens.prefix, createdAt: s.integrationTokens.createdAt, lastUsedAt: s.integrationTokens.lastUsedAt, lastUsedIp: s.integrationTokens.lastUsedIp })
        .from(s.integrationTokens)
        .where(and(sql`'omada.agent' = any(${s.integrationTokens.scopes})`, isNull(s.integrationTokens.revokedAt)))
        .orderBy(desc(s.integrationTokens.createdAt)),
    };
  }

  app.get('/integrations/omada', { config: { perm: 'integrations.read' } }, async () => view());

  app.put('/integrations/omada', { config: { perm: 'integrations.manage' } }, async (req) => {
    const body = omadaSettingsSchema.parse(req.body ?? {});
    const row = await getOmadaIntegration(db);
    let stored: OmadaSecrets | null = null;
    try {
      stored = readOmadaSecrets(app.config, row);
    } catch {
      stored = null;
    }
    const clientId = body.clientId || stored?.clientId || '';
    const clientSecret = body.clientSecret || stored?.clientSecret || '';
    const credentialsChanged = (!!body.clientId && body.clientId !== stored?.clientId) || (!!body.clientSecret && body.clientSecret !== stored?.clientSecret);
    if (body.enabled && body.mode === 'direct' && (!body.baseUrl || !clientId || !clientSecret)) {
      throw badRequest('Enter the controller address, Client ID and secret before enabling the integration', {
        fields: { ...(!body.baseUrl ? { baseUrl: 'Required' } : {}), ...(!clientId ? { clientId: 'Required' } : {}), ...(!clientSecret ? { clientSecret: 'Required' } : {}) },
      });
    }
    const before = readOmadaSettings(row);
    const config = { mode: body.mode, baseUrl: body.baseUrl, omadacId: body.omadacId, verifyTls: body.verifyTls, syncIntervalMinutes: body.syncIntervalMinutes, autoCreateCis: body.autoCreateCis, deviceKinds: body.deviceKinds };
    const connectionChanged = credentialsChanged || before.baseUrl !== body.baseUrl || before.omadacId !== body.omadacId;
    const hasCreds = body.mode === 'agent' || (!!clientId && !!clientSecret && !!body.baseUrl);
    const now = new Date();
    const status = !hasCreds ? 'not_configured' : !body.enabled ? 'disabled' : connectionChanged || ['not_configured', 'disabled'].includes(row.status) ? 'pending' : row.status;
    await db
      .update(s.integrations)
      .set({
        enabled: body.enabled,
        config,
        ...(credentialsChanged ? { secretsEncrypted: encryptJson(app.config.encryptionKey, { clientId, clientSecret }) } : {}),
        status,
        ...(connectionChanged ? { lastError: null } : {}),
        nextSyncAt: body.enabled && body.mode === 'direct' ? (connectionChanged || !row.enabled || !row.nextSyncAt ? now : row.nextSyncAt) : null,
      })
      .where(eq(s.integrations.id, row.id));
    await audit(db, req, { action: 'update', entityType: 'integration', entityId: row.id, summary: `Updated Omada integration settings${credentialsChanged ? ' (credentials changed)' : ''}` });
    return view();
  });

  /** Tries the (possibly unsaved) address and credentials. */
  app.post('/integrations/omada/test', { config: { perm: 'integrations.manage' } }, async (req) => {
    const body = omadaSettingsSchema.partial().parse(req.body ?? {});
    const row = await getOmadaIntegration(db);
    const settings = readOmadaSettings(row);
    let stored: OmadaSecrets | null = null;
    try {
      stored = readOmadaSecrets(app.config, row);
    } catch {
      stored = null;
    }
    const baseUrl = body.baseUrl || settings.baseUrl;
    const clientId = body.clientId || stored?.clientId;
    const clientSecret = body.clientSecret || stored?.clientSecret;
    if (!baseUrl || !clientId || !clientSecret) return { ok: false, error: 'Enter the controller address, Client ID and secret first' };
    try {
      const client = buildOmadaClient({ baseUrl, clientId, clientSecret, omadacId: (body.omadacId ?? settings.omadacId) || null, verifyTls: body.verifyTls ?? settings.verifyTls });
      const r = await client.testConnection();
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  });

  app.post('/integrations/omada/sync', { config: { perm: 'integrations.manage' } }, async (req) => {
    const user = currentUser(req);
    if (boolParam((req.query as Record<string, unknown> | undefined)?.inline) === true) {
      const [running] = await db
        .select({ id: s.syncRuns.id })
        .from(s.syncRuns)
        .where(and(eq(s.syncRuns.provider, OMADA_PROVIDER), eq(s.syncRuns.status, 'running'), sql`${s.syncRuns.startedAt} > now() - interval '30 minutes'`));
      if (running) throw conflict('An Omada synchronisation is already running');
      return runOmadaSync(db, app.config, { trigger: 'manual', userId: user.id });
    }
    const inserted = await db
      .insert(s.jobs)
      .values({ type: OMADA_SYNC_JOB, payload: { trigger: 'manual', userId: user.id }, dedupeKey: OMADA_SYNC_JOB })
      .onConflictDoNothing()
      .returning({ id: s.jobs.id });
    if (!inserted.length) return { queued: false, reason: 'An Omada synchronisation is already queued or running' };
    return { queued: true, jobId: inserted[0]!.id };
  });

  app.get('/integrations/omada/runs', { config: { perm: 'integrations.read' } }, async () =>
    db
      .select({ id: s.syncRuns.id, trigger: s.syncRuns.trigger, status: s.syncRuns.status, startedAt: s.syncRuns.startedAt, finishedAt: s.syncRuns.finishedAt, stats: s.syncRuns.stats, error: s.syncRuns.error, log: s.syncRuns.log })
      .from(s.syncRuns)
      .where(eq(s.syncRuns.provider, OMADA_PROVIDER))
      .orderBy(desc(s.syncRuns.startedAt))
      .limit(20),
  );

  /* ---------------------------------------------------------- sites */

  app.get('/integrations/omada/sites', { config: { perm: 'integrations.read' } }, async () =>
    db
      .select({ site: s.omadaSites, companyName: s.companies.name })
      .from(s.omadaSites)
      .leftJoin(s.companies, eq(s.companies.id, s.omadaSites.companyId))
      .orderBy(asc(s.omadaSites.name))
      .then((rows) => rows.map((r) => ({ ...r.site, companyName: r.companyName }))),
  );

  app.patch('/integrations/omada/sites/:id', { config: { perm: 'integrations.manage' } }, async (req) => {
    const input = omadaSiteMappingSchema.partial().parse(req.body ?? {});
    const body = req.body as Record<string, unknown>;
    const [site] = await db.select().from(s.omadaSites).where(eq(s.omadaSites.id, idOf(req)));
    if (!site) throw notFound('Omada site');
    if (input.companyId) {
      const [co] = await db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.id, input.companyId));
      if (!co) throw badRequest('Unknown company', { fields: { companyId: 'Unknown company' } });
    }
    const data: Partial<typeof site> = {};
    if ('companyId' in body) data.companyId = input.companyId ?? null;
    if ('enabled' in body) data.enabled = !!input.enabled;
    const [row] = await db.update(s.omadaSites).set({ ...data, updatedAt: new Date() }).where(eq(s.omadaSites.id, site.id)).returning();
    // Unmapping a site unlinks its devices from the old company's CIs at the next sync.
    await audit(db, req, { action: 'update', entityType: 'integration', summary: `Omada site ${site.name} mapping updated` });
    return row;
  });

  /* -------------------------------------------------------- devices */

  app.get('/integrations/omada/devices', { config: { perm: 'integrations.read' } }, async (req) => {
    const q = req.query as { siteId?: string; kind?: string };
    return db
      .select({
        device: s.omadaDevices,
        siteName: s.omadaSites.name,
        companyId: s.omadaSites.companyId,
        companyName: s.companies.name,
        ciName: s.configurationItems.name,
        activeClients: sql<number>`(select count(*)::int from omada_clients oc where oc.device_mac = ${s.omadaDevices.mac} and oc.active)`,
      })
      .from(s.omadaDevices)
      .leftJoin(s.omadaSites, eq(s.omadaSites.siteId, s.omadaDevices.siteId))
      .leftJoin(s.companies, eq(s.companies.id, s.omadaSites.companyId))
      .leftJoin(s.configurationItems, eq(s.configurationItems.id, s.omadaDevices.configurationItemId))
      .where(and(q.siteId ? eq(s.omadaDevices.siteId, q.siteId) : undefined, q.kind ? eq(s.omadaDevices.kind, q.kind) : undefined))
      .orderBy(asc(s.omadaSites.name), asc(s.omadaDevices.name))
      .limit(2000)
      .then((rows) => rows.map((r) => ({ ...r.device, raw: undefined, siteName: r.siteName, companyId: r.companyId, companyName: r.companyName, ciName: r.ciName, activeClients: r.activeClients })));
  });

  /** Omada state of a configuration item and the clients connected to it. */
  app.get('/configuration-items/:id/omada', { config: { perm: 'cis.read' } }, async (req) => {
    const [dev] = await db
      .select({ device: s.omadaDevices, siteName: s.omadaSites.name })
      .from(s.omadaDevices)
      .leftJoin(s.omadaSites, eq(s.omadaSites.siteId, s.omadaDevices.siteId))
      .where(eq(s.omadaDevices.configurationItemId, idOf(req)));
    if (!dev) return { linked: false };
    const clients = await db
      .select()
      .from(s.omadaClients)
      .where(and(eq(s.omadaClients.siteId, dev.device.siteId), or(eq(s.omadaClients.deviceMac, dev.device.mac))))
      .orderBy(desc(s.omadaClients.active), desc(s.omadaClients.lastSeenAt))
      .limit(300);
    const { raw, ...device } = dev.device;
    return {
      linked: true,
      siteName: dev.siteName,
      device,
      extra: {
        modelVersion: raw.modelVersion ?? null,
        publicIp: raw.publicIp ?? null,
        tagName: raw.tagName ?? null,
      },
      clients: clients.map(({ raw: _r, ...c }) => c),
    };
  });
}

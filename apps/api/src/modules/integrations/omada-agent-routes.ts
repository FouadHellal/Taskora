/**
 * Omada site agent: a small program installed next to the Omada controller (on the
 * controller's machine or any machine of the client's network) reads the controller's
 * Open API locally and pushes the sites, devices and clients to Taskora over HTTPS with a
 * scoped integration token (`omada.agent`). No inbound access to the client network is
 * needed, and the Omada credentials never leave the site.
 *
 *   GET  /integrations/omada/agent/config   (token) → what to send and how often
 *   POST /integrations/omada/agent/push     (token) → the data (or an error report)
 *   GET  /integrations/omada/agent/files/*  (public) → the agent and its installers
 */
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../../db/schema/index.js';
import type { Tx } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { currentUser } from '../../lib/context.js';
import { notFound } from '../../lib/errors.js';
import { newIntegrationToken } from '../../integrations/atlas/service.js';
import { getOmadaIntegration, ingestOmadaSite, OMADA_PROVIDER, readOmadaSettings, type OmadaSyncStats } from '../../integrations/omada/sync.js';

export const OMADA_AGENT_VERSION = '1.0.0';
const STATE_KEY = 'omada_agent';
const AGENT_FILES: Record<string, string> = {
  'omada-agent.mjs': 'text/javascript; charset=utf-8',
  'install-windows.ps1': 'text/plain; charset=utf-8',
  'install-linux.sh': 'text/x-shellscript; charset=utf-8',
};

export interface AgentState {
  lastSeenAt: string | null;
  lastPushAt: string | null;
  version: string | null;
  host: string | null;
  platform: string | null;
  controllerVersion: string | null;
  lastError: string | null;
  latestVersion: string;
}

export async function agentState(db: Tx): Promise<AgentState> {
  const [row] = await db.select().from(s.systemSettings).where(eq(s.systemSettings.key, STATE_KEY));
  const v = (row?.value ?? {}) as Partial<AgentState>;
  return {
    lastSeenAt: v.lastSeenAt ?? null,
    lastPushAt: v.lastPushAt ?? null,
    version: v.version ?? null,
    host: v.host ?? null,
    platform: v.platform ?? null,
    controllerVersion: v.controllerVersion ?? null,
    lastError: v.lastError ?? null,
    latestVersion: OMADA_AGENT_VERSION,
  };
}

async function saveAgentState(db: Tx, patch: Partial<AgentState>) {
  const value = { ...(await agentState(db)), ...patch };
  await db.insert(s.systemSettings).values({ key: STATE_KEY, value }).onConflictDoUpdate({ target: s.systemSettings.key, set: { value } });
}

const record = z.record(z.string(), z.unknown());
const pushSchema = z.object({
  agent: z
    .object({
      version: z.string().max(40).optional(),
      host: z.string().max(200).optional(),
      platform: z.string().max(100).optional(),
      controllerVersion: z.string().max(60).nullish(),
    })
    .default({}),
  /** The agent could not read the controller: shown on the Omada page. */
  error: z.string().max(2000).nullish(),
  sites: z
    .array(
      z.object({
        siteId: z.string().min(1).max(100),
        name: z.string().max(200).default(''),
        devices: z.array(record).max(5000).optional(),
        clientStats: z.array(record).max(5000).optional(),
        clients: z.array(record).max(20000).optional(),
      }),
    )
    .max(1000)
    .default([]),
});

export async function omadaAgentRoutes(app: FastifyInstance) {
  const db = app.db;
  const agentDir = resolve(process.cwd(), 'agents', 'omada');

  /* ------------------------------------------------- set-up (IT side) */

  /** Creates an agent token; shown once. */
  app.post('/integrations/omada/agent/token', { config: { perm: 'integrations.manage' } }, async (req, reply) => {
    const user = currentUser(req);
    const { token, hash, prefix } = newIntegrationToken();
    const name = `Omada agent ${new Date().toISOString().slice(0, 10)}`;
    const [row] = await db.insert(s.integrationTokens).values({ name, prefix, tokenHash: hash, scopes: ['omada.agent'], createdById: user.id }).returning({ id: s.integrationTokens.id });
    await audit(db, req, { action: 'create', entityType: 'integration_token', entityId: row!.id, summary: `${name} created` });
    return reply.status(201).send({ id: row!.id, token, prefix });
  });

  /** The agent and its installers (no secrets inside; public so the install command can fetch them). */
  app.get('/integrations/omada/agent/files/:name', { config: { public: true } }, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    const type = AGENT_FILES[name];
    if (!type) throw notFound('File');
    const file = join(agentDir, name);
    await stat(file).catch(() => {
      throw notFound('File');
    });
    return reply.header('content-type', type).header('cache-control', 'no-store').send(createReadStream(file));
  });

  /* ------------------------------------------------- agent (token) */

  app.get('/integrations/omada/agent/config', { config: { scope: 'omada.agent' } }, async (req) => {
    const row = await getOmadaIntegration(db);
    const settings = readOmadaSettings(row);
    const sites = await db
      .select({ siteId: s.omadaSites.siteId })
      .from(s.omadaSites)
      .where(and(eq(s.omadaSites.enabled, true), isNotNull(s.omadaSites.companyId)));
    const agent = (req.query as { version?: string; host?: string }) ?? {};
    await saveAgentState(db, { lastSeenAt: new Date().toISOString(), ...(agent.version ? { version: agent.version } : {}), ...(agent.host ? { host: agent.host } : {}) });
    return {
      enabled: settings.enabled && settings.mode === 'agent',
      intervalMinutes: settings.syncIntervalMinutes,
      deviceKinds: settings.deviceKinds,
      mappedSiteIds: sites.map((x) => x.siteId),
      latestVersion: OMADA_AGENT_VERSION,
    };
  });

  app.post('/integrations/omada/agent/push', { config: { scope: 'omada.agent' }, bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const body = pushSchema.parse(req.body);
    const now = new Date();
    const row = await getOmadaIntegration(db);
    const settings = readOmadaSettings(row);
    await saveAgentState(db, {
      lastSeenAt: now.toISOString(),
      version: body.agent.version ?? null,
      host: body.agent.host ?? null,
      platform: body.agent.platform ?? null,
      controllerVersion: body.agent.controllerVersion ?? null,
      lastError: body.error ?? null,
    });
    if (!settings.enabled || settings.mode !== 'agent') return { accepted: false, reason: 'The Omada integration is not enabled in agent mode in Taskora' };

    if (body.error) {
      await db.update(s.integrations).set({ status: 'error', lastSyncAt: now, lastError: `Agent: ${body.error}`.slice(0, 1000) }).where(eq(s.integrations.id, row.id));
      return { accepted: true, error: true };
    }

    const [run] = await db.insert(s.syncRuns).values({ provider: OMADA_PROVIDER, trigger: 'agent' }).returning();
    const log: { at: string; level: string; message: string }[] = [];
    const note = (level: string, message: string) => log.push({ at: new Date().toISOString(), level, message });
    const stats: OmadaSyncStats = { sites: body.sites.length, mappedSites: 0, devices: 0, cisMatched: 0, cisCreated: 0, clients: 0 };
    try {
      for (const site of body.sites) {
        await db
          .insert(s.omadaSites)
          .values({ siteId: site.siteId, name: site.name || site.siteId })
          .onConflictDoUpdate({ target: s.omadaSites.siteId, set: { name: site.name || site.siteId, updatedAt: now } });
      }
      const mapped = body.sites.length
        ? await db
            .select()
            .from(s.omadaSites)
            .where(and(eq(s.omadaSites.enabled, true), isNotNull(s.omadaSites.companyId), inArray(s.omadaSites.siteId, body.sites.map((x) => x.siteId))))
        : [];
      for (const site of mapped) {
        const data = body.sites.find((x) => x.siteId === site.siteId)!;
        if (!data.devices) continue; // the agent did not read this site (mapped after its last config fetch)
        stats.mappedSites++;
        await ingestOmadaSite(db, site, { devices: data.devices, clientStats: data.clientStats, clients: data.clients ?? [] }, settings, stats, note, now);
      }
      if (!stats.mappedSites) note('info', 'No site is mapped to a company yet: map the sites, then wait for the next agent run.');
      await db.delete(s.omadaClients).where(lt(s.omadaClients.lastSeenAt, new Date(now.getTime() - 30 * 86400_000)));
      await db.update(s.syncRuns).set({ status: 'success', finishedAt: new Date(), stats: stats as unknown as Record<string, number>, log }).where(eq(s.syncRuns.id, run!.id));
      await db.update(s.integrations).set({ status: 'connected', lastSyncAt: now, lastSuccessAt: now, lastError: null }).where(eq(s.integrations.id, row.id));
      await saveAgentState(db, { lastPushAt: now.toISOString() });
      return { accepted: true, stats };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.update(s.syncRuns).set({ status: 'failed', finishedAt: new Date(), stats: stats as unknown as Record<string, number>, log, error: message.slice(0, 1000) }).where(eq(s.syncRuns.id, run!.id));
      await db.update(s.integrations).set({ status: 'error', lastSyncAt: now, lastError: message.slice(0, 1000) }).where(eq(s.integrations.id, row.id));
      throw err;
    }
  });
}

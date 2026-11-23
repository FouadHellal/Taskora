import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ACTION1_REGIONS, action1EndpointResolveSchema, action1OrgMappingSchema, action1SettingsSchema } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { encryptJson } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { boolParam, countAll, intParam, orderFrom, paginated, parseList, searchAny, whereAll } from '../../lib/query.js';
import { currentUser } from '../../lib/context.js';
import { Action1Error, action1OrgDashboardUrl } from '../../integrations/action1/client.js';
import {
  ACTION1_PROVIDER,
  ACTION1_SYNC_JOB,
  buildAction1Client,
  createCiForEndpoint,
  fetchMissingUpdatesForCi,
  getAction1Integration,
  readAction1Secrets,
  readAction1Settings,
  runAction1Sync,
  type Action1Secrets,
  type IntegrationRow,
} from '../../integrations/action1/sync.js';
import type { Tx } from '../../db/client.js';
import { getOmadaIntegration } from '../../integrations/omada/sync.js';

const PROVIDER_LABELS: Record<string, string> = { action1: 'Action1', omada: 'TP-Link Omada' };

const testBodySchema = z
  .object({
    region: z.enum(ACTION1_REGIONS.values).optional(),
    clientId: z.string().trim().max(255).optional(),
    clientSecret: z.string().trim().max(1024).optional(),
  })
  .default({});

function hasSecrets(row: IntegrationRow) {
  return !!row.secretsEncrypted;
}

function clientIdHint(clientId: string | undefined | null): string | null {
  if (!clientId) return null;
  return clientId.length <= 4 ? '****' : `…${clientId.slice(-4)}`;
}

/** Maps Action1 client errors to a 502 for the API caller (message never contains secrets). */
function upstream(err: unknown): never {
  if (err instanceof Action1Error) throw new AppError(502, 'action1_error', err.message);
  throw err;
}

export async function integrationRoutes(app: FastifyInstance) {
  const db = app.db;

  /** Settings + status view of the Action1 integration (no secrets). */
  async function action1View(dbx: Tx = db) {
    const row = await getAction1Integration(dbx);
    const settings = readAction1Settings(row);
    let hint: string | null = null;
    let credentialsError: string | null = null;
    try {
      hint = clientIdHint(readAction1Secrets(app.config, row)?.clientId);
    } catch (err) {
      credentialsError = err instanceof Error ? err.message : 'Stored credentials are unreadable';
    }
    const counts = await dbx
      .select({ matchStatus: s.action1Endpoints.matchStatus, n: countAll })
      .from(s.action1Endpoints)
      .groupBy(s.action1Endpoints.matchStatus);
    const endpointCounts: Record<string, number> = {};
    let total = 0;
    for (const c of counts) {
      endpointCounts[c.matchStatus] = c.n;
      total += c.n;
    }
    const [missing] = await dbx.select({ n: countAll }).from(s.action1Endpoints).where(sql`${s.action1Endpoints.missingSince} is not null`);
    const [latestRun] = await dbx
      .select({
        id: s.syncRuns.id,
        trigger: s.syncRuns.trigger,
        status: s.syncRuns.status,
        startedAt: s.syncRuns.startedAt,
        finishedAt: s.syncRuns.finishedAt,
        stats: s.syncRuns.stats,
        error: s.syncRuns.error,
      })
      .from(s.syncRuns)
      .where(eq(s.syncRuns.provider, ACTION1_PROVIDER))
      .orderBy(desc(s.syncRuns.startedAt), desc(s.syncRuns.id))
      .limit(1);
    return {
      provider: ACTION1_PROVIDER,
      ...settings,
      hasCredentials: hasSecrets(row),
      clientIdHint: hint,
      credentialsError,
      status: row.status,
      lastSyncAt: row.lastSyncAt,
      lastSuccessAt: row.lastSuccessAt,
      lastError: row.lastError,
      nextSyncAt: row.nextSyncAt,
      endpointCounts: { ...endpointCounts, total, missing: missing?.n ?? 0 },
      latestRun: latestRun ?? null,
    };
  }

  /* ------------------------------------------------------------ overview */

  app.get('/integrations', { config: { perm: 'integrations.read' } }, async () => {
    await getAction1Integration(db); // make sure the known provider rows exist
    await getOmadaIntegration(db);
    const rows = await db.select().from(s.integrations).orderBy(asc(s.integrations.provider));
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      label: PROVIDER_LABELS[r.provider] ?? r.provider,
      enabled: r.enabled,
      status: r.status,
      hasCredentials: hasSecrets(r),
      lastSyncAt: r.lastSyncAt,
      lastSuccessAt: r.lastSuccessAt,
      lastError: r.lastError,
      nextSyncAt: r.nextSyncAt,
    }));
  });

  /* ------------------------------------------------------------- settings */

  app.get('/integrations/action1', { config: { perm: 'integrations.read' } }, async () => action1View());

  app.put('/integrations/action1', { config: { perm: 'integrations.manage' } }, async (req) => {
    const body = action1SettingsSchema.parse(req.body ?? {});
    const row = await getAction1Integration(db);
    let stored: Action1Secrets | null = null;
    try {
      stored = readAction1Secrets(app.config, row);
    } catch {
      stored = null; // unreadable: the user must re-enter both values
    }
    const clientId = body.clientId || stored?.clientId || '';
    const clientSecret = body.clientSecret || stored?.clientSecret || '';
    const credentialsChanged = (!!body.clientId && body.clientId !== stored?.clientId) || (!!body.clientSecret && body.clientSecret !== stored?.clientSecret);
    if (body.enabled && (!clientId || !clientSecret)) {
      throw badRequest('Enter the Action1 Client ID and secret before enabling the integration', {
        fields: { ...(!clientId ? { clientId: 'Required' } : {}), ...(!clientSecret ? { clientSecret: 'Required' } : {}) },
      });
    }
    if (credentialsChanged && (!clientId || !clientSecret)) {
      throw badRequest('Enter both the Action1 Client ID and secret', {
        fields: { ...(!clientId ? { clientId: 'Required' } : {}), ...(!clientSecret ? { clientSecret: 'Required' } : {}) },
      });
    }
    if (body.defaultCiTypeId) {
      const [t] = await db.select({ id: s.ciTypes.id }).from(s.ciTypes).where(eq(s.ciTypes.id, body.defaultCiTypeId));
      if (!t) throw badRequest('Unknown CI type', { fields: { defaultCiTypeId: 'Unknown CI type' } });
    }
    const before = readAction1Settings(row);
    const config = {
      region: body.region,
      syncIntervalMinutes: body.syncIntervalMinutes,
      autoCreateCis: body.autoCreateCis,
      matchBySerial: body.matchBySerial,
      matchByHostname: body.matchByHostname,
      matchContacts: body.matchContacts,
      defaultCiTypeId: body.defaultCiTypeId ?? null,
    };
    const hasCreds = !!clientId && !!clientSecret;
    const connectionChanged = credentialsChanged || before.region !== body.region;
    const now = new Date();
    let status = row.status;
    if (!hasCreds) status = 'not_configured';
    else if (!body.enabled) status = 'disabled';
    else if (connectionChanged || row.status === 'not_configured' || row.status === 'disabled') status = 'pending';

    await db
      .update(s.integrations)
      .set({
        enabled: body.enabled,
        config,
        ...(credentialsChanged ? { secretsEncrypted: encryptJson(app.config.encryptionKey, { clientId, clientSecret }) } : {}),
        status,
        ...(connectionChanged ? { lastError: null } : {}),
        nextSyncAt: body.enabled ? (connectionChanged || !row.enabled || !row.nextSyncAt ? now : row.nextSyncAt) : null,
      })
      .where(eq(s.integrations.id, row.id));

    const changes: Record<string, unknown> = diff(before as unknown as Record<string, unknown>, { ...config, enabled: body.enabled });
    if (credentialsChanged) changes.credentials = ['(unchanged)', '(updated)'];
    await audit(db, req, {
      action: 'update',
      entityType: 'integration',
      entityId: row.id,
      summary: `Updated Action1 integration settings${credentialsChanged ? ' (credentials changed)' : ''}`,
      changes,
    });
    return action1View();
  });

  /* ------------------------------------------------------- test / sync */

  app.post('/integrations/action1/test', { config: { perm: 'integrations.manage' } }, async (req) => {
    const body = testBodySchema.parse(req.body ?? {});
    const row = await getAction1Integration(db);
    let stored: Action1Secrets | null = null;
    try {
      stored = readAction1Secrets(app.config, row);
    } catch (err) {
      if (!body.clientId || !body.clientSecret) return { ok: false, error: err instanceof Error ? err.message : 'Stored credentials are unreadable' };
    }
    const clientId = body.clientId || stored?.clientId;
    const clientSecret = body.clientSecret || stored?.clientSecret;
    if (!clientId || !clientSecret) return { ok: false, error: 'Enter the Action1 Client ID and secret first' };
    const region = body.region ?? readAction1Settings(row).region;
    try {
      const client = buildAction1Client(app.config, region, { clientId, clientSecret });
      const res = await client.testConnection();
      return { ok: true, organizations: res.organizations };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  });

  app.post('/integrations/action1/sync', { config: { perm: 'integrations.manage' } }, async (req) => {
    const user = currentUser(req);
    const inline = boolParam((req.query as Record<string, unknown> | undefined)?.inline) === true;
    const [pendingJob] = await db
      .select({ id: s.jobs.id, status: s.jobs.status })
      .from(s.jobs)
      .where(and(eq(s.jobs.dedupeKey, ACTION1_SYNC_JOB), or(eq(s.jobs.status, 'pending'), eq(s.jobs.status, 'running'))));
    if (inline) {
      const [running] = await db
        .select({ id: s.syncRuns.id })
        .from(s.syncRuns)
        .where(and(eq(s.syncRuns.provider, ACTION1_PROVIDER), eq(s.syncRuns.status, 'running'), sql`${s.syncRuns.startedAt} > now() - interval '30 minutes'`));
      if (running || pendingJob?.status === 'running') throw conflict('An Action1 synchronisation is already running');
      return runAction1Sync(db, app.config, { trigger: 'manual', userId: user.id });
    }
    const inserted = await db
      .insert(s.jobs)
      .values({ type: ACTION1_SYNC_JOB, payload: { trigger: 'manual', userId: user.id }, dedupeKey: ACTION1_SYNC_JOB })
      .onConflictDoNothing()
      .returning({ id: s.jobs.id });
    if (!inserted.length) return { queued: false, reason: 'An Action1 synchronisation is already queued or running' };
    return { queued: true, jobId: inserted[0]!.id };
  });

  /* ---------------------------------------------------------------- runs */

  app.get('/integrations/action1/runs', { config: { perm: 'integrations.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(eq(s.syncRuns.provider, ACTION1_PROVIDER), q.status ? eq(s.syncRuns.status, String(q.status)) : undefined);
    const rows = await db
      .select({
        id: s.syncRuns.id,
        provider: s.syncRuns.provider,
        trigger: s.syncRuns.trigger,
        status: s.syncRuns.status,
        startedAt: s.syncRuns.startedAt,
        finishedAt: s.syncRuns.finishedAt,
        stats: s.syncRuns.stats,
        error: s.syncRuns.error,
        triggeredById: s.syncRuns.triggeredById,
        triggeredByName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
      })
      .from(s.syncRuns)
      .leftJoin(s.users, eq(s.users.id, s.syncRuns.triggeredById))
      .where(where)
      .orderBy(desc(s.syncRuns.startedAt), desc(s.syncRuns.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await db.select({ n: countAll }).from(s.syncRuns).where(where)) as [{ n: number }];
    return paginated(rows, n, q);
  });

  app.get('/integrations/action1/runs/:id', { config: { perm: 'integrations.read' } }, async (req) => {
    const id = idOf(req);
    const [row] = await db
      .select({ run: s.syncRuns, triggeredByName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}` })
      .from(s.syncRuns)
      .leftJoin(s.users, eq(s.users.id, s.syncRuns.triggeredById))
      .where(and(eq(s.syncRuns.id, id), eq(s.syncRuns.provider, ACTION1_PROVIDER)));
    if (!row) throw notFound('Sync run');
    return { ...row.run, triggeredByName: row.triggeredByName };
  });

  /* -------------------------------------------------------- organizations */

  const orgEndpointTotal = sql<number>`(select count(*)::int from action1_endpoints e where e.org_external_id = ${s.action1Organizations.externalId})`;
  const orgEndpointLinked = sql<number>`(select count(*)::int from action1_endpoints e where e.org_external_id = ${s.action1Organizations.externalId} and e.configuration_item_id is not null)`;
  const orgEndpointReview = sql<number>`(select count(*)::int from action1_endpoints e where e.org_external_id = ${s.action1Organizations.externalId} and e.match_status in ('unmatched','conflict'))`;

  async function orgView(id: number) {
    const [row] = await db
      .select({
        org: s.action1Organizations,
        companyName: s.companies.name,
        endpointTotal: orgEndpointTotal,
        endpointLinked: orgEndpointLinked,
        endpointNeedsReview: orgEndpointReview,
      })
      .from(s.action1Organizations)
      .leftJoin(s.companies, eq(s.companies.id, s.action1Organizations.companyId))
      .where(eq(s.action1Organizations.id, id));
    if (!row) throw notFound('Action1 organization');
    return { ...row.org, companyName: row.companyName, endpointTotal: row.endpointTotal, endpointLinked: row.endpointLinked, endpointNeedsReview: row.endpointNeedsReview };
  }

  app.get('/integrations/action1/organizations', { config: { perm: 'integrations.read' } }, async () => {
    const rows = await db
      .select({
        org: s.action1Organizations,
        companyName: s.companies.name,
        endpointTotal: orgEndpointTotal,
        endpointLinked: orgEndpointLinked,
        endpointNeedsReview: orgEndpointReview,
      })
      .from(s.action1Organizations)
      .leftJoin(s.companies, eq(s.companies.id, s.action1Organizations.companyId))
      .orderBy(asc(s.action1Organizations.name));
    return rows.map((r) => ({ ...r.org, companyName: r.companyName, endpointTotal: r.endpointTotal, endpointLinked: r.endpointLinked, endpointNeedsReview: r.endpointNeedsReview }));
  });

  app.patch('/integrations/action1/organizations/:id', { config: { perm: 'integrations.manage' } }, async (req) => {
    const id = idOf(req);
    const body = action1OrgMappingSchema.parse(req.body ?? {});
    const [org] = await db.select().from(s.action1Organizations).where(eq(s.action1Organizations.id, id));
    if (!org) throw notFound('Action1 organization');
    if (body.companyId) {
      const [company] = await db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.id, body.companyId));
      if (!company) throw badRequest('Unknown company', { fields: { companyId: 'Unknown company' } });
    }
    const newCompanyId = body.companyId ?? null;
    await db.update(s.action1Organizations).set({ companyId: newCompanyId, enabled: body.enabled }).where(eq(s.action1Organizations.id, id));

    // Links are never removed automatically; report endpoints linked to CIs of another company.
    let linkedToOtherCompany = 0;
    if (org.companyId && org.companyId !== newCompanyId) {
      const [r] = await db
        .select({ n: countAll })
        .from(s.action1Endpoints)
        .innerJoin(s.configurationItems, eq(s.configurationItems.id, s.action1Endpoints.configurationItemId))
        .where(
          and(
            eq(s.action1Endpoints.orgExternalId, org.externalId),
            newCompanyId ? ne(s.configurationItems.companyId, newCompanyId) : undefined,
          ),
        );
      linkedToOtherCompany = r?.n ?? 0;
    }
    await audit(db, req, {
      action: 'update',
      entityType: 'action1_organization',
      entityId: id,
      summary: `Action1 organization "${org.name}" mapping updated`,
      changes: diff({ companyId: org.companyId, enabled: org.enabled }, { companyId: newCompanyId, enabled: body.enabled }),
    });
    const view = await orgView(id);
    return {
      ...view,
      warning: linkedToOtherCompany
        ? {
            linkedToOtherCompany,
            message: `${linkedToOtherCompany} endpoint(s) of this organization remain linked to configuration items of ${newCompanyId ? 'another' : 'the previously mapped'} company. Review them; links are not removed automatically.`,
          }
        : null,
    };
  });

  /* ------------------------------------------------------------ endpoints */

  const ep = s.action1Endpoints;
  const endpointColumns = {
    id: ep.id,
    externalId: ep.externalId,
    orgExternalId: ep.orgExternalId,
    orgName: s.action1Organizations.name,
    companyId: s.action1Organizations.companyId,
    companyName: s.companies.name,
    configurationItemId: ep.configurationItemId,
    ciName: s.configurationItems.name,
    ciNumber: s.configurationItems.ciNumber,
    ciCompanyId: s.configurationItems.companyId,
    contactId: ep.contactId,
    contactName: sql<string | null>`${s.contacts.firstName} || ' ' || ${s.contacts.lastName}`,
    name: ep.name,
    deviceName: ep.deviceName,
    osName: ep.osName,
    platform: ep.platform,
    serialNumber: ep.serialNumber,
    manufacturer: ep.manufacturer,
    ipAddress: ep.ipAddress,
    macAddress: ep.macAddress,
    loggedInUser: ep.loggedInUser,
    agentStatus: ep.agentStatus,
    onlineStatus: ep.onlineStatus,
    lastSeenAt: ep.lastSeenAt,
    lastBootAt: ep.lastBootAt,
    rebootRequired: ep.rebootRequired,
    updateStatus: ep.updateStatus,
    vulnerabilityStatus: ep.vulnerabilityStatus,
    missingCriticalUpdates: ep.missingCriticalUpdates,
    missingOtherUpdates: ep.missingOtherUpdates,
    agentVersion: ep.agentVersion,
    cpu: ep.cpu,
    ramText: ep.ramText,
    diskText: ep.diskText,
    matchStatus: ep.matchStatus,
    matchNote: ep.matchNote,
    contactMatchNote: ep.contactMatchNote,
    missingSince: ep.missingSince,
    previousNames: ep.previousNames,
    firstSeenAt: ep.firstSeenAt,
    lastSyncedAt: ep.lastSyncedAt,
  };
  const endpointQuery = () =>
    db
      .select(endpointColumns)
      .from(ep)
      .leftJoin(s.action1Organizations, eq(s.action1Organizations.externalId, ep.orgExternalId))
      .leftJoin(s.companies, eq(s.companies.id, s.action1Organizations.companyId))
      .leftJoin(s.configurationItems, eq(s.configurationItems.id, ep.configurationItemId))
      .leftJoin(s.contacts, eq(s.contacts.id, ep.contactId));

  const attentionCond = sql`(${ep.rebootRequired} is true or coalesce(${ep.missingCriticalUpdates}, 0) > 0 or ${ep.agentStatus} = 'Disconnected')`;

  app.get('/integrations/action1/endpoints', { config: { perm: 'integrations.read' } }, async (req) => {
    const q = parseList(req.query);
    const companyId = intParam(q.companyId);
    const where = whereAll(
      searchAny(q.q, [ep.name, ep.deviceName, ep.serialNumber, ep.loggedInUser]),
      q.matchStatus ? eq(ep.matchStatus, String(q.matchStatus)) : undefined,
      q.orgExternalId ? eq(ep.orgExternalId, String(q.orgExternalId)) : undefined,
      companyId ? eq(s.action1Organizations.companyId, companyId) : undefined,
      boolParam(q.attention) === true ? attentionCond : undefined,
      boolParam(q.missing) === true ? sql`${ep.missingSince} is not null` : undefined,
    );
    const rows = await endpointQuery()
      .where(where)
      .orderBy(
        ...(q.sort
          ? orderFrom(q.sort, q.order, { name: ep.name, lastSeenAt: ep.lastSeenAt, matchStatus: ep.matchStatus, missingCriticalUpdates: ep.missingCriticalUpdates, companyName: s.companies.name }, ep.name)
          : [asc(ep.name), asc(ep.id)]),
      )
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await db
      .select({ n: countAll })
      .from(ep)
      .leftJoin(s.action1Organizations, eq(s.action1Organizations.externalId, ep.orgExternalId))
      .where(where)) as [{ n: number }];
    return paginated(rows, n, q);
  });

  app.get('/integrations/action1/endpoints/:id', { config: { perm: 'integrations.read' } }, async (req) => {
    const id = idOf(req);
    const [row] = await endpointQuery().where(eq(ep.id, id));
    if (!row) throw notFound('Action1 endpoint');
    const [extra] = await db.select({ missingUpdates: ep.missingUpdates, raw: ep.raw }).from(ep).where(eq(ep.id, id));
    return { ...row, missingUpdates: extra?.missingUpdates ?? null, raw: extra?.raw ?? {} };
  });

  app.post('/integrations/action1/endpoints/:id/resolve', { config: { perm: 'integrations.manage' } }, async (req) => {
    const user = currentUser(req);
    const id = idOf(req);
    const body = action1EndpointResolveSchema.parse(req.body ?? {});
    const [endpoint] = await db.select().from(ep).where(eq(ep.id, id));
    if (!endpoint) throw notFound('Action1 endpoint');
    const [org] = await db.select().from(s.action1Organizations).where(eq(s.action1Organizations.externalId, endpoint.orgExternalId));
    const companyId = org?.companyId ?? null;
    const label = endpoint.name ?? endpoint.deviceName ?? endpoint.externalId;

    if (body.action === 'link') {
      if (!body.configurationItemId) throw badRequest('Select a configuration item', { fields: { configurationItemId: 'Required' } });
      if (!companyId) throw badRequest('Map the Action1 organization to a company before linking its endpoints');
      const [ci] = await db.select().from(s.configurationItems).where(eq(s.configurationItems.id, body.configurationItemId));
      if (!ci) throw notFound('Configuration item');
      if (ci.companyId !== companyId) {
        throw badRequest('The configuration item belongs to another company than the mapped Action1 organization', {
          fields: { configurationItemId: 'Belongs to another company' },
        });
      }
      const [other] = await db.select({ id: ep.id, name: ep.name }).from(ep).where(and(eq(ep.configurationItemId, ci.id), ne(ep.id, id)));
      if (other) throw conflict(`${ci.ciNumber} is already linked to Action1 endpoint "${other.name ?? other.id}"`);
      await db.update(ep).set({ configurationItemId: ci.id, matchStatus: 'matched', matchNote: `Linked manually to ${ci.ciNumber}` }).where(eq(ep.id, id));
      await audit(db, req, {
        action: 'update',
        entityType: 'action1_endpoint',
        entityId: id,
        summary: `Linked Action1 endpoint "${label}" to ${ci.ciNumber}`,
        changes: { configurationItemId: [endpoint.configurationItemId, ci.id], matchStatus: [endpoint.matchStatus, 'matched'] },
      });
    } else if (body.action === 'create') {
      if (!companyId) throw badRequest('Map the Action1 organization to a company before creating CIs for its endpoints');
      if (endpoint.configurationItemId) throw conflict('This endpoint is already linked to a configuration item');
      const settings = readAction1Settings(await getAction1Integration(db));
      const ci = await createCiForEndpoint(db, endpoint, {
        companyId,
        contactId: endpoint.contactId,
        defaultCiTypeId: settings.defaultCiTypeId,
        userId: user.id,
      });
      await audit(db, req, {
        action: 'update',
        entityType: 'action1_endpoint',
        entityId: id,
        summary: `Created ${ci.ciNumber} for Action1 endpoint "${label}"`,
        changes: { configurationItemId: [null, ci.id], matchStatus: [endpoint.matchStatus, 'created'] },
      });
    } else if (body.action === 'ignore') {
      // Explicit admin action: stop syncing this endpoint into the CMDB. The CI itself is kept.
      await db.update(ep).set({ matchStatus: 'ignored', configurationItemId: null, matchNote: `Ignored by ${user.firstName} ${user.lastName}` }).where(eq(ep.id, id));
      await audit(db, req, {
        action: 'update',
        entityType: 'action1_endpoint',
        entityId: id,
        summary: `Ignored Action1 endpoint "${label}"`,
        changes: { matchStatus: [endpoint.matchStatus, 'ignored'], configurationItemId: [endpoint.configurationItemId, null] },
      });
    } else {
      if (endpoint.matchStatus !== 'ignored') throw badRequest('This endpoint is not ignored');
      const next = companyId ? 'unmatched' : 'unmapped_org';
      await db.update(ep).set({ matchStatus: next, matchNote: null }).where(eq(ep.id, id));
      await audit(db, req, {
        action: 'update',
        entityType: 'action1_endpoint',
        entityId: id,
        summary: `Stopped ignoring Action1 endpoint "${label}"`,
        changes: { matchStatus: ['ignored', next] },
      });
    }
    const [row] = await endpointQuery().where(eq(ep.id, id));
    return row;
  });

  /* ------------------------------------------------- CI detail integration */

  app.get('/configuration-items/:id/action1', { config: { perm: 'cis.read' } }, async (req) => {
    const id = idOf(req);
    const [ci] = await db.select({ id: s.configurationItems.id }).from(s.configurationItems).where(eq(s.configurationItems.id, id));
    if (!ci) throw notFound('Configuration item');
    const [row] = await endpointQuery().where(eq(ep.configurationItemId, id));
    if (!row) return { linked: false };
    const [extra] = await db.select({ missingUpdates: ep.missingUpdates }).from(ep).where(eq(ep.id, row.id));
    const settings = readAction1Settings(await getAction1Integration(db));
    return {
      linked: true,
      endpoint: { ...row, missingUpdates: extra?.missingUpdates ?? null },
      // Only the organization dashboard link is documented; there is no documented per-endpoint deep link.
      consoleUrl: action1OrgDashboardUrl(settings.region, row.orgExternalId),
      consoleUrlLabel: 'Open organization dashboard in Action1',
    };
  });

  app.post('/configuration-items/:id/action1/refresh-updates', { config: { perm: 'cis.read' } }, async (req) => {
    const id = idOf(req);
    const [ci] = await db.select({ id: s.configurationItems.id }).from(s.configurationItems).where(eq(s.configurationItems.id, id));
    if (!ci) throw notFound('Configuration item');
    try {
      const items = await fetchMissingUpdatesForCi(db, app.config, id);
      return { items, count: items.length, fetchedAt: new Date().toISOString() };
    } catch (err) {
      return upstream(err);
    }
  });
}

/**
 * Action1 → Taskora CMDB synchronisation (read-only towards Action1: only GET requests + token).
 *
 * Rules enforced here:
 *  - Organizations are never mapped to companies automatically; an admin maps them explicitly.
 *  - Matching never crosses companies: candidates are always restricted to the org's mapped company.
 *  - CIs are never deleted or retired; endpoints that disappear only get `missingSince`.
 *  - Values from Action1 never overwrite CI data with null; user-entered names are only replaced for
 *    CIs that were created by this integration (source 'action1').
 */
import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { action1SettingsSchema, formatNumber } from '@taskora/shared';
import type { Config } from '../../config.js';
import type { Db, Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { decryptJson } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { nextSequence } from '../../lib/query.js';
import { getSystemSettings } from '../../lib/settings.js';
import { Action1Client, type Action1ClientOptions, type Action1Region } from './client.js';
import { endpointHostname, guessCiTypeName, matchContactCandidates, normalizeEndpoint, str } from './normalize.js';

export const ACTION1_PROVIDER = 'action1';
export const ACTION1_SYNC_JOB = 'action1.sync';

export type SyncRun = typeof s.syncRuns.$inferSelect;
export type IntegrationRow = typeof s.integrations.$inferSelect;
export type EndpointRow = typeof s.action1Endpoints.$inferSelect;
type CiInsert = typeof s.configurationItems.$inferInsert;

export interface Action1Settings {
  enabled: boolean;
  region: Action1Region;
  syncIntervalMinutes: number;
  autoCreateCis: boolean;
  matchBySerial: boolean;
  matchByHostname: boolean;
  matchContacts: boolean;
  defaultCiTypeId: number | null;
}

export interface Action1Secrets {
  clientId: string;
  clientSecret: string;
}

export interface SyncOptions {
  trigger: 'manual' | 'scheduled';
  userId?: number | null;
  /** Pre-built client (tests). Defaults to a client built from the stored settings and secrets. */
  client?: Action1Client;
}

/** Note stored when a linked CI was deleted; such endpoints are not auto-recreated. */
export const CI_DELETED_NOTE = 'The linked configuration item was deleted; link or create a CI manually.';

/* ------------------------------------------------------------- settings */

export function readAction1Settings(row: Pick<IntegrationRow, 'config' | 'enabled'> | null | undefined): Action1Settings {
  const input = { ...(row?.config ?? {}), enabled: row?.enabled ?? false, clientId: undefined, clientSecret: undefined };
  const parsed = action1SettingsSchema.safeParse(input);
  const v = parsed.success ? parsed.data : action1SettingsSchema.parse({ enabled: row?.enabled ?? false });
  return {
    enabled: v.enabled,
    region: v.region,
    syncIntervalMinutes: v.syncIntervalMinutes,
    autoCreateCis: v.autoCreateCis,
    matchBySerial: v.matchBySerial,
    matchByHostname: v.matchByHostname,
    matchContacts: v.matchContacts,
    defaultCiTypeId: v.defaultCiTypeId ?? null,
  };
}

/**
 * Decrypts stored credentials. Returns null when none are stored; throws when they cannot be
 * decrypted (e.g. TASKORA_ENCRYPTION_KEY changed). The error never contains secret material.
 */
export function readAction1Secrets(config: Config, row: Pick<IntegrationRow, 'secretsEncrypted'> | null | undefined): Action1Secrets | null {
  if (!row?.secretsEncrypted) return null;
  let value: Partial<Action1Secrets>;
  try {
    value = decryptJson<Partial<Action1Secrets>>(config.encryptionKey, row.secretsEncrypted);
  } catch {
    throw new AppError(500, 'secrets_unreadable', 'Stored Action1 credentials could not be decrypted (was TASKORA_ENCRYPTION_KEY changed?). Re-enter them.');
  }
  if (!value || typeof value.clientId !== 'string' || typeof value.clientSecret !== 'string' || !value.clientId || !value.clientSecret) return null;
  return { clientId: value.clientId, clientSecret: value.clientSecret };
}

/** Loads (and lazily creates) the Action1 integration row. */
export async function getAction1Integration(db: Tx): Promise<IntegrationRow> {
  const [row] = await db.select().from(s.integrations).where(eq(s.integrations.provider, ACTION1_PROVIDER));
  if (row) return row;
  await db.insert(s.integrations).values({ provider: ACTION1_PROVIDER, enabled: false }).onConflictDoNothing();
  const [created] = await db.select().from(s.integrations).where(eq(s.integrations.provider, ACTION1_PROVIDER));
  return created!;
}

export function buildAction1Client(
  config: Config,
  region: Action1Region,
  secrets: Action1Secrets,
  extra: Partial<Action1ClientOptions> = {},
): Action1Client {
  return new Action1Client({
    region,
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
    baseUrlOverride: config.ACTION1_BASE_URL_OVERRIDE ?? null,
    ...extra,
  });
}

/** Builds a client from the stored (decrypted) credentials and configured region. */
export async function getAction1Client(db: Tx, config: Config): Promise<Action1Client> {
  const row = await getAction1Integration(db);
  const secrets = readAction1Secrets(config, row);
  if (!secrets) throw new AppError(400, 'action1_not_configured', 'Action1 API credentials are not configured');
  return buildAction1Client(config, readAction1Settings(row).region, secrets);
}

/* -------------------------------------------------------------- helpers */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves the CI type for a new CI: guessed type → configured default → 'Other' → first active type. */
export async function resolveCiTypeId(db: Tx, guess: string | null, defaultCiTypeId: number | null, cache?: Map<string, number | null>): Promise<number> {
  const key = `${guess ?? ''}|${defaultCiTypeId ?? ''}`;
  const cached = cache?.get(key);
  if (cached) return cached;
  let id: number | null = null;
  if (guess) {
    const [t] = await db.select({ id: s.ciTypes.id }).from(s.ciTypes).where(and(eq(s.ciTypes.name, guess), eq(s.ciTypes.isActive, true)));
    id = t?.id ?? null;
  }
  if (!id && defaultCiTypeId) {
    const [t] = await db.select({ id: s.ciTypes.id }).from(s.ciTypes).where(eq(s.ciTypes.id, defaultCiTypeId));
    id = t?.id ?? null;
  }
  if (!id) {
    const [t] = await db.select({ id: s.ciTypes.id }).from(s.ciTypes).where(eq(s.ciTypes.name, 'Other'));
    id = t?.id ?? null;
  }
  if (!id) {
    const [t] = await db.select({ id: s.ciTypes.id }).from(s.ciTypes).where(eq(s.ciTypes.isActive, true)).orderBy(asc(s.ciTypes.sortOrder)).limit(1);
    id = t?.id ?? null;
  }
  if (!id) throw new Error('No CI type exists to create configuration items with');
  cache?.set(key, id);
  return id;
}

/**
 * Creates a CI (source 'action1') for an endpoint in the given company and links it.
 * Used by the sync and by the manual "create" resolution.
 */
export async function createCiForEndpoint(
  db: Db,
  ep: EndpointRow,
  opts: { companyId: number; contactId?: number | null; defaultCiTypeId: number | null; userId?: number | null; typeCache?: Map<string, number | null>; note?: string },
): Promise<typeof s.configurationItems.$inferSelect> {
  return db.transaction(async (tx) => {
    const guess = guessCiTypeName({ ...ep, raw: ep.raw });
    const ciTypeId = await resolveCiTypeId(tx, guess, opts.defaultCiTypeId, opts.typeCache);
    const settings = await getSystemSettings(tx);
    const ciNumber = formatNumber(settings.ciPrefix, await nextSequence(tx, 'ci'));
    const [ci] = await tx
      .insert(s.configurationItems)
      .values({
        ciNumber,
        name: ep.name ?? ep.deviceName ?? ep.externalId,
        ciTypeId,
        companyId: opts.companyId,
        contactId: opts.contactId ?? null,
        manufacturer: ep.manufacturer,
        serialNumber: ep.serialNumber,
        hostname: endpointHostname(ep),
        osName: ep.osName,
        ipAddress: ep.ipAddress,
        macAddress: ep.macAddress,
        cpu: ep.cpu,
        lifecycleStatus: 'active',
        lastSeenAt: ep.lastSeenAt,
        source: ACTION1_PROVIDER,
        createdById: opts.userId ?? null,
      })
      .returning();
    await tx
      .update(s.action1Endpoints)
      .set({ configurationItemId: ci!.id, matchStatus: 'created', matchNote: opts.note ?? `Created ${ciNumber}` })
      .where(eq(s.action1Endpoints.id, ep.id));
    await audit(
      tx,
      null,
      { action: 'create', entityType: 'configuration_item', entityId: ci!.id, summary: `Created ${ciNumber} from Action1 endpoint "${ci!.name}"` },
      opts.userId ?? null,
    );
    return ci!;
  });
}

/** Contact match for a logged-in user, restricted to active contacts of one company. */
export async function matchContact(
  db: Tx,
  companyId: number,
  loggedInUser: string | null,
  cache?: Map<number, { id: number; firstName: string; lastName: string; email: string | null }[]>,
): Promise<{ contactId: number | null; note: string | null }> {
  if (!loggedInUser) return { contactId: null, note: null };
  let contacts = cache?.get(companyId);
  if (!contacts) {
    contacts = await db
      .select({ id: s.contacts.id, firstName: s.contacts.firstName, lastName: s.contacts.lastName, email: s.contacts.email })
      .from(s.contacts)
      .where(and(eq(s.contacts.companyId, companyId), eq(s.contacts.isActive, true)));
    cache?.set(companyId, contacts);
  }
  const matches = matchContactCandidates(loggedInUser, contacts);
  if (matches.length === 1) return { contactId: matches[0]!.id, note: null };
  if (matches.length > 1) return { contactId: null, note: `Ambiguous: ${matches.length} contacts match "${loggedInUser}"` };
  return { contactId: null, note: `No contact matches "${loggedInUser}"` };
}

/* ----------------------------------------------------------------- sync */

interface RunState {
  db: Db;
  settings: Action1Settings;
  userId: number | null;
  stats: Record<string, number>;
  log: { at: string; level: string; message: string }[];
  typeCache: Map<string, number | null>;
  contactCache: Map<number, { id: number; firstName: string; lastName: string; email: string | null }[]>;
}

function say(st: RunState, level: 'info' | 'warn' | 'error', message: string) {
  st.log.push({ at: new Date().toISOString(), level, message });
}

export async function runAction1Sync(db: Db, config: Config, opts: SyncOptions): Promise<SyncRun> {
  const userId = opts.userId ?? null;
  const [run] = await db
    .insert(s.syncRuns)
    .values({ provider: ACTION1_PROVIDER, trigger: opts.trigger, status: 'running', triggeredById: userId })
    .returning();
  const st: RunState = {
    db,
    settings: readAction1Settings(null),
    userId,
    stats: { orgs: 0, orgsSynced: 0, endpoints: 0, newEndpoints: 0, created: 0, updated: 0, matched: 0, unmatched: 0, conflicts: 0, unmapped: 0, ignored: 0, errors: 0, missing: 0 },
    log: [],
    typeCache: new Map(),
    contactCache: new Map(),
  };
  let integ: IntegrationRow | null = null;

  const finish = async (status: 'success' | 'partial' | 'failed', error: string | null, touchStatus = true): Promise<SyncRun> => {
    if (error && status === 'failed') say(st, 'error', error);
    const now = new Date();
    const [row] = await db
      .update(s.syncRuns)
      .set({ status, finishedAt: now, stats: st.stats, log: st.log, error })
      .where(eq(s.syncRuns.id, run!.id))
      .returning();
    if (integ) {
      const enabled = integ.enabled;
      await db
        .update(s.integrations)
        .set({
          ...(touchStatus ? { status: status === 'success' ? 'ok' : 'error' } : {}),
          lastSyncAt: now,
          ...(status === 'success' ? { lastSuccessAt: now } : {}),
          lastError: error,
          nextSyncAt: enabled ? new Date(now.getTime() + st.settings.syncIntervalMinutes * 60_000) : null,
        })
        .where(eq(s.integrations.id, integ.id));
    }
    await audit(
      db,
      null,
      {
        action: 'sync',
        entityType: 'integration',
        entityId: integ?.id ?? null,
        summary: `Action1 sync ${status} (${opts.trigger})${error ? `: ${error}` : ''}`.slice(0, 500),
        changes: { runId: run!.id, status, stats: st.stats },
      },
      userId,
    );
    return row!;
  };

  try {
    integ = await getAction1Integration(db);
    st.settings = readAction1Settings(integ);
    if (!integ.enabled) {
      return await finish('failed', 'The Action1 integration is disabled. Enable it before synchronising.', false);
    }
    let client = opts.client;
    if (!client) {
      const secrets = readAction1Secrets(config, integ);
      if (!secrets) return await finish('failed', 'Action1 API credentials (Client ID and secret) are not configured.');
      client = buildAction1Client(config, st.settings.region, secrets);
    }

    let orgs;
    try {
      orgs = await client.listOrganizations();
    } catch (err) {
      return await finish('failed', `Could not list Action1 organizations: ${errMsg(err)}`);
    }
    st.stats.orgs = orgs.length;
    say(st, 'info', `Found ${orgs.length} Action1 organization(s)`);

    // Upsert organizations; never touch the company mapping here.
    for (const org of orgs) {
      await db
        .insert(s.action1Organizations)
        .values({ externalId: org.id, name: org.name })
        .onConflictDoUpdate({ target: s.action1Organizations.externalId, set: { name: org.name, updatedAt: new Date() } });
    }
    const orgRows = orgs.length
      ? await db.select().from(s.action1Organizations).where(inArray(s.action1Organizations.externalId, orgs.map((o) => o.id))).orderBy(asc(s.action1Organizations.name))
      : [];

    for (const org of orgRows) {
      if (!org.enabled) {
        say(st, 'info', `Organization "${org.name}" is disabled; skipped`);
        continue;
      }
      try {
        await syncOrganization(st, client, org);
      } catch (err) {
        st.stats.errors!++;
        say(st, 'error', `Organization "${org.name}": ${errMsg(err)}`);
      }
    }

    const errors = st.stats.errors!;
    if (errors === 0) return await finish('success', null);
    const status = st.stats.orgsSynced! > 0 ? 'partial' : 'failed';
    return await finish(status, `${errors} error(s) during synchronisation; see the run log`);
  } catch (err) {
    return finish('failed', `Synchronisation failed: ${errMsg(err)}`);
  }
}

async function syncOrganization(st: RunState, client: Action1Client, org: typeof s.action1Organizations.$inferSelect) {
  const { db } = st;
  let companyId: number | null = null;
  if (org.companyId) {
    const [company] = await db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.id, org.companyId));
    companyId = company?.id ?? null;
  }
  const raws = await client.listEndpoints(org.externalId);
  const seen = new Set<string>();
  for (const raw of raws) {
    const externalId = str(raw.id);
    if (!externalId) {
      say(st, 'warn', `Organization "${org.name}": skipped an endpoint without an id`);
      continue;
    }
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    try {
      await syncEndpoint(st, org.externalId, companyId, externalId, raw);
    } catch (err) {
      st.stats.errors!++;
      say(st, 'error', `Endpoint "${str(raw.name) ?? externalId}" (${org.name}): ${errMsg(err)}`);
    }
  }

  // Endpoints previously seen for this org but absent now: flag, never delete.
  const absent = await db
    .select({ id: s.action1Endpoints.id, name: s.action1Endpoints.name, missingSince: s.action1Endpoints.missingSince })
    .from(s.action1Endpoints)
    .where(and(eq(s.action1Endpoints.orgExternalId, org.externalId), seen.size ? notInArray(s.action1Endpoints.externalId, [...seen]) : undefined));
  const newlyMissing = absent.filter((a) => !a.missingSince);
  if (newlyMissing.length) {
    await db
      .update(s.action1Endpoints)
      .set({ missingSince: new Date() })
      .where(and(inArray(s.action1Endpoints.id, newlyMissing.map((a) => a.id)), isNull(s.action1Endpoints.missingSince)));
    for (const m of newlyMissing) say(st, 'warn', `Endpoint "${m.name ?? m.id}" is no longer reported by Action1 (${org.name}); marked missing`);
  }
  st.stats.missing! += absent.length;

  await db.update(s.action1Organizations).set({ endpointCount: seen.size, lastSyncedAt: new Date() }).where(eq(s.action1Organizations.id, org.id));
  st.stats.orgsSynced!++;
  say(st, 'info', `Organization "${org.name}": ${seen.size} endpoint(s)${companyId ? '' : ' (not mapped to a company; no CIs created or linked)'}`);
}

async function syncEndpoint(st: RunState, orgExternalId: string, companyId: number | null, externalId: string, raw: Record<string, unknown>) {
  const { db, settings } = st;
  const n = normalizeEndpoint(raw);
  const now = new Date();
  const snapshot = {
    orgExternalId,
    name: n.name,
    deviceName: n.deviceName,
    osName: n.osName,
    platform: n.platform,
    serialNumber: n.serialNumber,
    manufacturer: n.manufacturer,
    ipAddress: n.ipAddress,
    macAddress: n.macAddress,
    loggedInUser: n.loggedInUser,
    agentStatus: n.agentStatus,
    onlineStatus: n.onlineStatus,
    lastSeenAt: n.lastSeenAt,
    lastBootAt: n.lastBootAt,
    rebootRequired: n.rebootRequired,
    updateStatus: n.updateStatus,
    vulnerabilityStatus: n.vulnerabilityStatus,
    missingCriticalUpdates: n.missingCriticalUpdates,
    missingOtherUpdates: n.missingOtherUpdates,
    agentVersion: n.agentVersion,
    cpu: n.cpu,
    ramText: n.ramText,
    diskText: n.diskText,
    raw: n.raw,
    lastSyncedAt: now,
    missingSince: null,
  };

  const [existing] = await db.select().from(s.action1Endpoints).where(eq(s.action1Endpoints.externalId, externalId));
  let ep: EndpointRow;
  if (existing) {
    const previousNames = [...existing.previousNames];
    if (existing.name && n.name && existing.name !== n.name) {
      if (!previousNames.includes(existing.name)) previousNames.push(existing.name);
      say(st, 'info', `Endpoint "${existing.name}" was renamed to "${n.name}"`);
    }
    [ep] = (await db.update(s.action1Endpoints).set({ ...snapshot, previousNames }).where(eq(s.action1Endpoints.id, existing.id)).returning()) as [EndpointRow];
  } else {
    [ep] = (await db.insert(s.action1Endpoints).values({ externalId, ...snapshot, matchStatus: companyId ? 'unmatched' : 'unmapped_org' }).returning()) as [EndpointRow];
    st.stats.newEndpoints!++;
  }
  st.stats.endpoints!++;

  if (ep.matchStatus === 'ignored') {
    st.stats.ignored!++;
    return;
  }
  if (!companyId) {
    st.stats.unmapped!++;
    if (!ep.configurationItemId && ep.matchStatus !== 'unmapped_org') {
      await setMatch(db, ep, 'unmapped_org', 'The Action1 organization is not mapped to a company');
    }
    return;
  }

  let contactId: number | null = ep.contactId;
  if (settings.matchContacts) {
    const m = await matchContact(db, companyId, ep.loggedInUser, st.contactCache);
    contactId = m.contactId;
    if (m.contactId !== ep.contactId || m.note !== ep.contactMatchNote) {
      await db.update(s.action1Endpoints).set({ contactId: m.contactId, contactMatchNote: m.note }).where(eq(s.action1Endpoints.id, ep.id));
      ep = { ...ep, contactId: m.contactId, contactMatchNote: m.note };
    }
  }

  if (ep.configurationItemId) {
    await updateLinkedCi(st, ep, companyId, contactId);
    return;
  }

  // Previously linked but the CI was deleted (FK set null): do not silently recreate it.
  if (existing && (existing.matchStatus === 'matched' || existing.matchStatus === 'created')) {
    await setMatch(db, ep, 'unmatched', CI_DELETED_NOTE);
    ep = { ...ep, matchStatus: 'unmatched', matchNote: CI_DELETED_NOTE };
  }

  await matchOrCreate(st, ep, companyId, contactId);
}

async function setMatch(db: Tx, ep: EndpointRow, status: string, note: string | null, configurationItemId?: number) {
  await db
    .update(s.action1Endpoints)
    .set({ matchStatus: status, matchNote: note, ...(configurationItemId ? { configurationItemId } : {}) })
    .where(eq(s.action1Endpoints.id, ep.id));
}

type Candidate = { id: number; ciNumber: string; linkedEndpointId: number | null };

function listCis(cands: Candidate[]) {
  return cands.map((c) => c.ciNumber).join(', ');
}

async function matchOrCreate(st: RunState, ep: EndpointRow, companyId: number, contactId: number | null) {
  const { db, settings } = st;
  const ci = s.configurationItems;
  const select = () =>
    db
      .select({ id: ci.id, ciNumber: ci.ciNumber, linkedEndpointId: s.action1Endpoints.id })
      .from(ci)
      .leftJoin(s.action1Endpoints, eq(s.action1Endpoints.configurationItemId, ci.id));

  const decide = async (cands: Candidate[], what: string): Promise<boolean> => {
    if (!cands.length) return false;
    const free = cands.filter((c) => c.linkedEndpointId === null || c.linkedEndpointId === ep.id);
    if (free.length === 1) {
      await setMatch(db, ep, 'matched', `Matched by ${what} to ${free[0]!.ciNumber}`, free[0]!.id);
      st.stats.matched!++;
      say(st, 'info', `Endpoint "${ep.name}" matched by ${what} to ${free[0]!.ciNumber}`);
      await updateLinkedCi(st, { ...ep, configurationItemId: free[0]!.id }, companyId, contactId);
      return true;
    }
    const note =
      free.length > 1
        ? `${free.length} CIs in this company match by ${what}: ${listCis(free)}`
        : `Matches ${listCis(cands)} by ${what}, but that CI is already linked to another Action1 endpoint`;
    await setMatch(db, ep, 'conflict', note);
    st.stats.conflicts!++;
    say(st, 'warn', `Endpoint "${ep.name}": ${note}`);
    return true;
  };

  // (b) serial number within the same company (case-insensitive).
  if (settings.matchBySerial && ep.serialNumber) {
    const cands = await select().where(and(eq(ci.companyId, companyId), sql`lower(${ci.serialNumber}) = ${ep.serialNumber.toLowerCase()}`));
    if (await decide(cands, 'serial number')) return;
  }

  // (b2) MAC address within the same company: reuses a CI atlas (or a person) created for the
  // device before the agent was installed, instead of creating a duplicate.
  const mac = normalMac(ep.macAddress);
  if (mac) {
    const cands = await select().where(and(eq(ci.companyId, companyId), sql`lower(replace(${ci.macAddress}, '-', ':')) = ${mac}`));
    if (await decide(cands, 'MAC address')) return;
  }

  // (c) host name / CI name within the same company, unique match only.
  if (settings.matchByHostname) {
    const names = [...new Set([ep.deviceName, ep.name].filter((x): x is string => !!x).map((x) => x.toLowerCase()))];
    if (names.length) {
      const cands = await select().where(
        and(eq(ci.companyId, companyId), or(inArray(sql`lower(${ci.hostname})`, names), inArray(sql`lower(${ci.name})`, names))),
      );
      if (await decide(cands, 'host name')) return;
    }
  }

  // (d) create, unless the user deleted the previously linked CI.
  if (settings.autoCreateCis && ep.matchNote !== CI_DELETED_NOTE) {
    const created = await createCiForEndpoint(db, ep, {
      companyId,
      contactId,
      defaultCiTypeId: settings.defaultCiTypeId,
      userId: st.userId,
      typeCache: st.typeCache,
    });
    st.stats.created!++;
    say(st, 'info', `Created ${created.ciNumber} for endpoint "${created.name}"`);
    return;
  }

  st.stats.unmatched!++;
  if (ep.matchStatus !== 'unmatched' || (ep.matchNote !== CI_DELETED_NOTE && ep.matchNote !== 'No matching CI found')) {
    await setMatch(db, ep, 'unmatched', ep.matchNote === CI_DELETED_NOTE ? CI_DELETED_NOTE : 'No matching CI found');
  }
}

/** `aa:bb:cc:dd:ee:ff` for a usable unicast MAC, else null (placeholders never match). */
export function normalMac(raw: string | null | undefined): string | null {
  const m = raw?.trim().toLowerCase().replace(/-/g, ':');
  if (!m || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)) return null;
  if (m === '00:00:00:00:00:00' || m === 'ff:ff:ff:ff:ff:ff') return null;
  return m;
}

/** Refreshes Action1-sourced fields of a linked CI without overwriting with nulls. */
async function updateLinkedCi(st: RunState, ep: EndpointRow, companyId: number, contactId: number | null) {
  const { db } = st;
  const [ci] = await db.select().from(s.configurationItems).where(eq(s.configurationItems.id, ep.configurationItemId!));
  if (!ci) return;
  if (ci.companyId !== companyId) {
    say(st, 'warn', `Endpoint "${ep.name}" is linked to ${ci.ciNumber}, which belongs to another company; the CI was not updated`);
    return;
  }
  const patch: Partial<CiInsert> = {};
  const host = endpointHostname(ep);
  if (host && host !== ci.hostname) patch.hostname = host;
  if (ep.osName && ep.osName !== ci.osName) patch.osName = ep.osName;
  if (ep.ipAddress && ep.ipAddress !== ci.ipAddress) patch.ipAddress = ep.ipAddress;
  if (ep.macAddress && ep.macAddress !== ci.macAddress) patch.macAddress = ep.macAddress;
  if (ep.lastSeenAt && ep.lastSeenAt.getTime() !== ci.lastSeenAt?.getTime()) patch.lastSeenAt = ep.lastSeenAt;
  if (!ci.serialNumber && ep.serialNumber) patch.serialNumber = ep.serialNumber;
  if (!ci.manufacturer && ep.manufacturer) patch.manufacturer = ep.manufacturer;
  // A CI atlas created from observation becomes Action1's once the agent reports it (TASKORA_DECISIONS #25).
  const adopt = ci.source === 'atlas';
  if (adopt) patch.source = ACTION1_PROVIDER;
  if ((ci.source === ACTION1_PROVIDER || adopt) && ep.name && ep.name !== ci.name) patch.name = ep.name;
  if (contactId && !ci.contactId) patch.contactId = contactId;
  if (!Object.keys(patch).length) return;

  await db.update(s.configurationItems).set(patch).where(eq(s.configurationItems.id, ci.id));
  st.stats.updated!++;
  if (patch.name) say(st, 'info', `Renamed ${ci.ciNumber} from "${ci.name}" to "${patch.name}"`);
  // Only audit meaningful changes (last-seen/IP churn on every sync would flood the audit log).
  const meaningful = Object.keys(patch).filter((k) => k !== 'lastSeenAt' && k !== 'ipAddress');
  if (meaningful.length) {
    await audit(
      db,
      null,
      {
        action: 'update',
        entityType: 'configuration_item',
        entityId: ci.id,
        summary: patch.name ? `Renamed from "${ci.name}" to "${patch.name}" (Action1)` : `Updated ${ci.ciNumber} from Action1`,
        changes: diff(ci as unknown as Record<string, unknown>, patch as Record<string, unknown>),
      },
      st.userId,
    );
  }
}

/* ------------------------------------------------- on-demand missing updates */

/**
 * Fetches the missing updates of the endpoint linked to a CI (read-only GET), stores them in
 * `action1_endpoints.missing_updates` and returns them.
 */
export async function fetchMissingUpdatesForCi(db: Db, config: Config, ciId: number): Promise<Record<string, unknown>[]> {
  const [ep] = await db.select().from(s.action1Endpoints).where(eq(s.action1Endpoints.configurationItemId, ciId));
  if (!ep) throw new AppError(404, 'not_found', 'This configuration item is not linked to an Action1 endpoint');
  const client = await getAction1Client(db, config);
  const items = await client.getEndpointMissingUpdates(ep.orgExternalId, ep.externalId);
  await db.update(s.action1Endpoints).set({ missingUpdates: items }).where(eq(s.action1Endpoints.id, ep.id));
  return items;
}

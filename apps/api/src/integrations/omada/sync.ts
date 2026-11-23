/**
 * Omada synchronisation: sites (mapped explicitly to companies), devices of the mapped sites
 * (access points by default, optionally switches and gateways) linked to configuration items
 * — matched by MAC, then serial number, then name within the company, otherwise created —
 * and the clients currently connected to them. Read-only towards Omada.
 */
import { and, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { formatNumber, omadaSettingsSchema, OMADA_DEVICE_KINDS } from '@taskora/shared';
import type { Config } from '../../config.js';
import type { Db, Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { decryptJson } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { nextSequence } from '../../lib/query.js';
import { getSystemSettings } from '../../lib/settings.js';
import { OmadaClient, type OmadaClientOptions } from './client.js';

export const OMADA_PROVIDER = 'omada';
export const OMADA_SYNC_JOB = 'omada.sync';

type IntegrationRow = typeof s.integrations.$inferSelect;
export type OmadaKind = (typeof OMADA_DEVICE_KINDS)[number] | 'other';

export interface OmadaSettings {
  enabled: boolean;
  baseUrl: string;
  omadacId: string;
  verifyTls: boolean;
  syncIntervalMinutes: number;
  autoCreateCis: boolean;
  deviceKinds: OmadaKind[];
}
export interface OmadaSecrets {
  clientId: string;
  clientSecret: string;
}

export function readOmadaSettings(row: Pick<IntegrationRow, 'config' | 'enabled'> | null | undefined): OmadaSettings {
  const parsed = omadaSettingsSchema.safeParse({ ...(row?.config ?? {}), enabled: row?.enabled ?? false, clientId: undefined, clientSecret: undefined });
  const v = parsed.success ? parsed.data : omadaSettingsSchema.parse({ enabled: row?.enabled ?? false });
  return { enabled: v.enabled, baseUrl: v.baseUrl, omadacId: v.omadacId, verifyTls: v.verifyTls, syncIntervalMinutes: v.syncIntervalMinutes, autoCreateCis: v.autoCreateCis, deviceKinds: v.deviceKinds };
}

export function readOmadaSecrets(config: Config, row: Pick<IntegrationRow, 'secretsEncrypted'> | null | undefined): OmadaSecrets | null {
  if (!row?.secretsEncrypted) return null;
  let v: Partial<OmadaSecrets>;
  try {
    v = decryptJson<Partial<OmadaSecrets>>(config.encryptionKey, row.secretsEncrypted);
  } catch {
    throw new AppError(500, 'secrets_unreadable', 'Stored Omada credentials could not be decrypted (was TASKORA_ENCRYPTION_KEY changed?). Re-enter them.');
  }
  return v?.clientId && v.clientSecret ? { clientId: v.clientId, clientSecret: v.clientSecret } : null;
}

export async function getOmadaIntegration(db: Tx): Promise<IntegrationRow> {
  const [row] = await db.select().from(s.integrations).where(eq(s.integrations.provider, OMADA_PROVIDER));
  if (row) return row;
  await db.insert(s.integrations).values({ provider: OMADA_PROVIDER, enabled: false }).onConflictDoNothing();
  const [created] = await db.select().from(s.integrations).where(eq(s.integrations.provider, OMADA_PROVIDER));
  return created!;
}

/** Test hook: lets tests inject a fake transport. */
let clientFactory: (opts: OmadaClientOptions) => OmadaClient = (opts) => new OmadaClient(opts);
export function setOmadaClientFactory(f: ((opts: OmadaClientOptions) => OmadaClient) | null) {
  clientFactory = f ?? ((opts) => new OmadaClient(opts));
}
export const buildOmadaClient = (opts: OmadaClientOptions) => clientFactory(opts);

/* ----------------------------------------------------------------- mapping */

export const normalizeMac = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
const prettyMac = (v: string) => (v.length === 12 ? v.toUpperCase().match(/../g)!.join(':') : v.toUpperCase());

export function deviceKind(d: Record<string, unknown>): OmadaKind {
  const t = `${d.type ?? ''} ${d.deviceSeriesType ?? ''}`.toLowerCase();
  if (/gateway|router|\ber\d/.test(t)) return 'gateway';
  if (/switch/.test(t)) return 'switch';
  if (/\bap\b|eap|access/.test(t) || String(d.model ?? '').toUpperCase().startsWith('EAP')) return 'ap';
  return 'other';
}

const KIND_CI_TYPE: Record<OmadaKind, string> = { ap: 'Wireless Access Point', switch: 'Network Switch', gateway: 'Router', other: 'Other' };

const num = (v: unknown) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

/** "4day(s) 17h 26m 57s" or seconds → seconds. */
export function uptimeSeconds(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v);
  if (typeof v !== 'string') return null;
  if (/^\d+$/.test(v)) return Number(v);
  const part = (re: RegExp) => Number(v.match(re)?.[1] ?? 0);
  const total = part(/(\d+)\s*day/) * 86400 + part(/(\d+)\s*h/) * 3600 + part(/(\d+)\s*m(?!s)/) * 60 + part(/(\d+)\s*s/);
  return total || null;
}

/** Omada timestamps are milliseconds since the epoch (sometimes seconds). */
const toDate = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
};

const DETAIL_STATUS: Record<number, string> = { 0: 'Disconnected', 1: 'Disconnected (migrating)', 10: 'Provisioning', 11: 'Configuring', 12: 'Upgrading', 13: 'Rebooting', 14: 'Connected', 15: 'Connected (wireless)', 16: 'Connected (migrating)', 17: 'Connected (wireless, migrating)', 20: 'Pending', 30: 'Heartbeat missed', 40: 'Isolated' };
const LINK_SPEED: Record<number, string> = { 0: 'Auto', 1: '10 Mbps', 2: '100 Mbps', 3: '1 Gbps', 4: '2.5 Gbps', 5: '10 Gbps', 6: '5 Gbps', 7: '25 Gbps', 8: '100 Gbps' };

function deviceStatus(d: Record<string, unknown>) {
  const detail = num(d.detailStatus);
  const cat = num(d.statusCategory);
  const st = num(d.status);
  const label = detail !== null ? (DETAIL_STATUS[detail] ?? `Status ${detail}`) : null;
  const online = detail !== null ? detail >= 14 && detail <= 17 : cat !== null ? cat === 1 : st === 1 || st === 14;
  const pending = detail !== null && detail >= 20 && detail < 30;
  return { status: online ? 'online' : pending ? 'pending' : 'offline', statusDetail: label };
}

/* --------------------------------------------------------------------- run */

export interface OmadaSyncStats {
  sites: number;
  mappedSites: number;
  devices: number;
  cisMatched: number;
  cisCreated: number;
  clients: number;
}

export async function runOmadaSync(db: Db, config: Config, opts: { trigger: 'manual' | 'scheduled'; userId?: number | null } = { trigger: 'scheduled' }) {
  const row = await getOmadaIntegration(db);
  const settings = readOmadaSettings(row);
  const secrets = readOmadaSecrets(config, row);
  const [run] = await db.insert(s.syncRuns).values({ provider: OMADA_PROVIDER, trigger: opts.trigger, triggeredById: opts.userId ?? null }).returning();
  const log: { at: string; level: string; message: string }[] = [];
  const note = (level: string, message: string) => log.push({ at: new Date().toISOString(), level, message });
  const stats: OmadaSyncStats = { sites: 0, mappedSites: 0, devices: 0, cisMatched: 0, cisCreated: 0, clients: 0 };
  const now = new Date();
  try {
    if (!settings.baseUrl || !secrets) throw new AppError(400, 'not_configured', 'Enter the controller address, Client ID and secret first');
    const client = buildOmadaClient({ baseUrl: settings.baseUrl, omadacId: settings.omadacId || null, verifyTls: settings.verifyTls, ...secrets });

    // 1. Sites (all of them, so they can be mapped).
    const sites = await client.sites();
    stats.sites = sites.length;
    for (const site of sites) {
      const siteId = String(site.siteId ?? site.id ?? '');
      if (!siteId) continue;
      await db
        .insert(s.omadaSites)
        .values({ siteId, name: String(site.name ?? siteId) })
        .onConflictDoUpdate({ target: s.omadaSites.siteId, set: { name: String(site.name ?? siteId), updatedAt: now } });
    }
    const mapped = await db
      .select()
      .from(s.omadaSites)
      .where(and(eq(s.omadaSites.enabled, true), sql`${s.omadaSites.companyId} is not null`, inArray(s.omadaSites.siteId, sites.map((x) => String(x.siteId ?? x.id ?? '')).concat(['']))));
    stats.mappedSites = mapped.length;
    if (!mapped.length) note('info', 'No site is mapped to a company yet: map the sites, then synchronise again.');

    const ciTypes = await db.select({ id: s.ciTypes.id, name: s.ciTypes.name }).from(s.ciTypes);
    const settingsSys = await getSystemSettings(db);

    for (const site of mapped) {
      const companyId = site.companyId!;
      // 2. Devices.
      const raw = await client.devices(site.siteId);
      const wanted = raw.filter((d) => settings.deviceKinds.includes(deviceKind(d)));
      const stat = await client.clientStats(site.siteId, wanted.map((d) => String(d.mac ?? '')).filter(Boolean));
      const statOf = new Map(stat.map((x) => [normalizeMac(x.mac), x]));
      const seen: string[] = [];
      for (const d of wanted) {
        const mac = normalizeMac(d.mac);
        if (mac.length !== 12) continue;
        seen.push(mac);
        stats.devices++;
        const kind = deviceKind(d);
        const st = deviceStatus(d);
        const bands = statOf.get(mac);
        const values = {
          siteId: site.siteId,
          kind,
          name: str(d.name),
          model: str(d.modelName ?? d.model),
          serialNumber: str(d.sn),
          firmwareVersion: str(d.firmwareVersion),
          ipAddress: str(d.ip),
          status: st.status,
          statusDetail: st.statusDetail,
          uptimeSeconds: uptimeSeconds(d.uptime),
          cpuUtil: num(d.cpuUtil),
          memUtil: num(d.memUtil),
          clientCount: num(bands?.clientNum ?? d.clientNum),
          clientCount2g: num(bands?.clientNum2g),
          clientCount5g: num((Number(bands?.clientNum5g ?? 0) + Number(bands?.clientNum5g2 ?? 0)) || (bands ? 0 : null)),
          clientCount6g: num(bands?.clientNum6g),
          uplinkDeviceName: str(d.uplinkDeviceName),
          uplinkPort: str(d.uplinkDevicePort),
          linkSpeed: d.linkSpeed !== undefined && d.linkSpeed !== null ? (LINK_SPEED[Number(d.linkSpeed)] ?? String(d.linkSpeed)) : null,
          lastSeenAt: toDate(d.lastSeen) ?? (st.status === 'online' ? now : null),
          raw: d,
          missingSince: null,
          lastSyncedAt: now,
        };
        const [dev] = await db
          .insert(s.omadaDevices)
          .values({ mac, ...values })
          .onConflictDoUpdate({ target: s.omadaDevices.mac, set: values })
          .returning();

        // 3. Configuration item: keep the link, or match MAC → serial → name in the company, or create.
        let ciId = dev!.configurationItemId;
        if (ciId) {
          const [ci] = await db.select({ companyId: s.configurationItems.companyId }).from(s.configurationItems).where(eq(s.configurationItems.id, ciId));
          if (!ci || ci.companyId !== companyId) ciId = null;
        }
        if (!ciId) {
          const taken = sql`${s.configurationItems.id} not in (select configuration_item_id from omada_devices where configuration_item_id is not null and mac <> ${mac})`;
          const inCompany = and(eq(s.configurationItems.companyId, companyId), taken);
          const [byMac] = await db.select({ id: s.configurationItems.id }).from(s.configurationItems).where(and(inCompany, sql`regexp_replace(lower(coalesce(${s.configurationItems.macAddress}, '')), '[^0-9a-f]', '', 'g') = ${mac}`)).limit(2);
          const bySerial = !byMac && values.serialNumber ? (await db.select({ id: s.configurationItems.id }).from(s.configurationItems).where(and(inCompany, sql`lower(${s.configurationItems.serialNumber}) = ${values.serialNumber.toLowerCase()}`)).limit(1))[0] : undefined;
          const byName = !byMac && !bySerial && values.name ? (await db.select({ id: s.configurationItems.id }).from(s.configurationItems).where(and(inCompany, sql`lower(${s.configurationItems.name}) = ${values.name.toLowerCase()}`)).limit(1))[0] : undefined;
          ciId = (byMac ?? bySerial ?? byName)?.id ?? null;
          if (ciId) stats.cisMatched++;
          else if (settings.autoCreateCis) {
            const typeId = ciTypes.find((t) => t.name === KIND_CI_TYPE[kind])?.id ?? ciTypes.find((t) => t.name === 'Other')?.id ?? ciTypes[0]?.id;
            if (typeId) {
              const [ci] = await db
                .insert(s.configurationItems)
                .values({
                  ciNumber: formatNumber(settingsSys.ciPrefix, await nextSequence(db, 'ci')),
                  name: values.name ?? prettyMac(mac),
                  ciTypeId: typeId,
                  companyId,
                  manufacturer: 'TP-Link',
                  model: values.model,
                  serialNumber: values.serialNumber,
                  macAddress: prettyMac(mac),
                  ipAddress: values.ipAddress,
                  osVersion: values.firmwareVersion,
                  lastSeenAt: values.lastSeenAt,
                  source: OMADA_PROVIDER,
                  notes: `Created from Omada site "${site.name}".`,
                })
                .returning({ id: s.configurationItems.id });
              ciId = ci!.id;
              stats.cisCreated++;
            }
          }
          if (ciId) await db.update(s.omadaDevices).set({ configurationItemId: ciId }).where(eq(s.omadaDevices.mac, mac));
        }
        // Keep the CI's network facts current (never its name or owner).
        if (ciId) {
          await db
            .update(s.configurationItems)
            .set({
              ipAddress: values.ipAddress ?? undefined,
              osVersion: values.firmwareVersion ?? undefined,
              lastSeenAt: values.lastSeenAt ?? undefined,
              macAddress: sql`coalesce(nullif(${s.configurationItems.macAddress}, ''), ${prettyMac(mac)})`,
              serialNumber: sql`coalesce(nullif(${s.configurationItems.serialNumber}, ''), ${values.serialNumber})`,
              model: sql`coalesce(nullif(${s.configurationItems.model}, ''), ${values.model})`,
              manufacturer: sql`coalesce(nullif(${s.configurationItems.manufacturer}, ''), 'TP-Link')`,
            })
            .where(eq(s.configurationItems.id, ciId));
        }
      }
      // Devices of the site that disappeared are flagged, never deleted.
      await db
        .update(s.omadaDevices)
        .set({ missingSince: now })
        .where(and(eq(s.omadaDevices.siteId, site.siteId), isNull(s.omadaDevices.missingSince), seen.length ? notInArray(s.omadaDevices.mac, seen) : undefined));

      // 4. Clients currently online.
      const clients = await client.clients(site.siteId);
      const online: string[] = [];
      for (const c of clients) {
        const mac = normalizeMac(c.mac);
        if (!mac) continue;
        online.push(mac);
        const wireless = c.wireless === true || c.wireless === 1 || !!c.ssid;
        const values = {
          siteId: site.siteId,
          deviceMac: normalizeMac(wireless ? c.apMac : (c.switchMac ?? c.gatewayMac)) || null,
          name: str(c.name),
          hostName: str(c.hostName),
          ipAddress: str(c.ip),
          vendor: str(c.vendor),
          osName: str(c.osName),
          deviceType: str(c.deviceType ?? c.deviceCategory),
          wireless,
          ssid: str(c.ssid),
          networkName: str(c.networkName),
          rssi: num(c.rssi),
          signalLevel: num(c.signalLevel),
          snr: num(c.snr),
          wifiMode: str(c.wifiMode),
          channel: num(c.channel),
          radio: str(c.radioId),
          rxRate: num(c.rxRate),
          txRate: num(c.txRate),
          trafficDown: num(c.trafficDown),
          trafficUp: num(c.trafficUp),
          uptimeSeconds: uptimeSeconds(c.uptime),
          switchPort: str(c.portName ?? c.port),
          guest: c.guest === true,
          active: true,
          lastSeenAt: toDate(c.lastSeen) ?? now,
          raw: c,
          lastSyncedAt: now,
        };
        await db
          .insert(s.omadaClients)
          .values({ mac, ...values })
          .onConflictDoUpdate({ target: [s.omadaClients.siteId, s.omadaClients.mac], set: values });
        stats.clients++;
      }
      await db
        .update(s.omadaClients)
        .set({ active: false })
        .where(and(eq(s.omadaClients.siteId, site.siteId), online.length ? notInArray(s.omadaClients.mac, online) : undefined));
      await db.update(s.omadaSites).set({ deviceCount: wanted.length, clientCount: online.length, lastSyncedAt: now }).where(eq(s.omadaSites.id, site.id));
      note('info', `${site.name}: ${wanted.length} device(s), ${online.length} client(s) online`);
    }
    // Clients not seen for 30 days are forgotten.
    await db.delete(s.omadaClients).where(lt(s.omadaClients.lastSeenAt, new Date(now.getTime() - 30 * 86400_000)));

    await db.update(s.syncRuns).set({ status: 'success', finishedAt: new Date(), stats: stats as unknown as Record<string, number>, log }).where(eq(s.syncRuns.id, run!.id));
    await db
      .update(s.integrations)
      .set({ status: 'connected', lastSyncAt: now, lastSuccessAt: now, lastError: null, nextSyncAt: settings.enabled ? new Date(now.getTime() + settings.syncIntervalMinutes * 60_000) : null })
      .where(eq(s.integrations.id, row.id));
    return { status: 'success' as const, stats, runId: run!.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note('error', message);
    await db.update(s.syncRuns).set({ status: 'failed', finishedAt: new Date(), stats: stats as unknown as Record<string, number>, log, error: message.slice(0, 1000) }).where(eq(s.syncRuns.id, run!.id));
    await db
      .update(s.integrations)
      .set({ status: 'error', lastSyncAt: now, lastError: message.slice(0, 1000), nextSyncAt: settings.enabled ? new Date(now.getTime() + settings.syncIntervalMinutes * 60_000) : null })
      .where(eq(s.integrations.id, row.id));
    return { status: 'failed' as const, stats, runId: run!.id, error: message };
  }
}

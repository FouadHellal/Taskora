/**
 * atlas integration (docs/integrations/atlas.md).
 *
 * - Incidents: `applyIncidentEvent` upserts one ticket per atlas incident (unique external key,
 *   row lock, monotonic revision), adds internal timeline notes for meaningful changes and
 *   applies the configured recovery / reopen policies. It never touches assignment, contacts,
 *   customer-visible notes or a technician's priority choice.
 * - Feed: `ticketEventsFeed` lets atlas read lifecycle events of linked tickets (pull), with the
 *   events atlas itself caused filtered out (origin = 'atlas'), so there is no loop.
 * - CMDB: `syncInventory` reconciles atlas entities with configuration items. Identity: the
 *   atlas external id first, then MAC / serial within the configured company (unique only),
 *   hostname only as a *proposal*. Ambiguity becomes a reviewable conflict; nothing is merged
 *   or deleted automatically. atlas observations live in `atlas_entities`; CI fields are only
 *   written for CIs atlas created and that no Action1 endpoint manages.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  type AtlasIncidentEvent,
  type AtlasInventorySync,
  type AtlasSettings,
  atlasSettingsSchema,
  formatNumber,
} from '@taskora/shared';
import type { Db, Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { nextSequence } from '../../lib/query.js';
import { getSystemSettings } from '../../lib/settings.js';
import { addTicketNote, createTicket, getTicketRow, updateTicket } from '../../modules/tickets/service.js';

export const ATLAS_PROVIDER = 'atlas';
export const ATLAS_ORIGIN = 'atlas';

export const DEFAULT_ATLAS_SETTINGS: AtlasSettings = {
  enabled: false,
  atlasBaseUrl: null,
  companyId: null,
  autoCreateTickets: true,
  queueId: null,
  ticketTypeId: null,
  sourceId: null,
  assignedUserId: null,
  priorityMap: { info: null, notice: null, warning: null },
  recoveryPolicy: 'resolve',
  resolvedStatusId: null,
  reopenPolicy: 'reopen',
  reopenStatusId: null,
  cmdbMode: 'off',
  ciTypeMap: {},
  defaultCiTypeId: null,
  staleDays: 7,
};

/* ------------------------------------------------------------------ settings */

export async function getAtlasSettings(db: Tx): Promise<{ settings: AtlasSettings; row: typeof s.integrations.$inferSelect | null }> {
  const [row] = await db.select().from(s.integrations).where(eq(s.integrations.provider, ATLAS_PROVIDER));
  const parsed = atlasSettingsSchema.safeParse({ ...DEFAULT_ATLAS_SETTINGS, ...(row?.config ?? {}) });
  return { settings: parsed.success ? parsed.data : DEFAULT_ATLAS_SETTINGS, row: row ?? null };
}

export async function saveAtlasSettings(db: Tx, settings: AtlasSettings) {
  const values = { config: settings as unknown as Record<string, unknown>, enabled: settings.enabled, status: settings.enabled ? 'configured' : 'disabled' };
  const [row] = await db
    .insert(s.integrations)
    .values({ provider: ATLAS_PROVIDER, ...values })
    .onConflictDoUpdate({ target: s.integrations.provider, set: { ...values, updatedAt: new Date() } })
    .returning();
  return row!;
}

async function recordContact(db: Tx, ok: boolean, error?: string) {
  await db
    .update(s.integrations)
    .set(ok ? { lastSyncAt: new Date(), lastSuccessAt: new Date(), lastError: null, status: 'connected' } : { lastSyncAt: new Date(), lastError: error?.slice(0, 500) ?? null, status: 'error' })
    .where(eq(s.integrations.provider, ATLAS_PROVIDER));
}

/* ------------------------------------------------------------------ incidents */

export interface IncidentResult {
  externalKey: string;
  applied: boolean;
  created: boolean;
  test: boolean;
  ticket: TicketSnapshot | null;
  note?: string;
}

export interface TicketSnapshot {
  id: number;
  number: string;
  title: string;
  status: string;
  statusCategory: string;
  priority: string;
  assignee: string | null;
  path: string;
  configurationItemId: number | null;
  ciNumber: string | null;
}

export async function ticketSnapshot(db: Tx, ticketId: number | null): Promise<TicketSnapshot | null> {
  if (!ticketId) return null;
  const [row] = await db
    .select({
      id: s.tickets.id,
      number: s.tickets.ticketNumber,
      title: s.tickets.title,
      status: s.ticketStatuses.name,
      statusCategory: s.ticketStatuses.category,
      priority: s.ticketPriorities.name,
      first: s.users.firstName,
      last: s.users.lastName,
      configurationItemId: s.tickets.configurationItemId,
      ciNumber: s.configurationItems.ciNumber,
    })
    .from(s.tickets)
    .innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId))
    .innerJoin(s.ticketPriorities, eq(s.ticketPriorities.id, s.tickets.priorityId))
    .leftJoin(s.users, eq(s.users.id, s.tickets.assignedUserId))
    .leftJoin(s.configurationItems, eq(s.configurationItems.id, s.tickets.configurationItemId))
    .where(eq(s.tickets.id, ticketId));
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    statusCategory: row.statusCategory,
    priority: row.priority,
    assignee: row.first ? `${row.first} ${row.last ?? ''}`.trim() : null,
    path: `/tickets/${row.id}`,
    configurationItemId: row.configurationItemId,
    ciNumber: row.ciNumber,
  };
}

export const externalKeyOf = (ev: Pick<AtlasIncidentEvent, 'instance' | 'incidentId'>) => `${ev.instance}:${ev.incidentId}`;

/** What changed in a way worth a timeline note (not the "last observed" heartbeat). */
function digest(ev: AtlasIncidentEvent): string {
  const meaningful = { severity: ev.severity, state: ev.state, checks: ev.checks, evidence: ev.evidence, entity: ev.entity?.key ?? null, persisting: ev.persisting };
  return createHash('sha256').update(JSON.stringify(meaningful)).digest('hex').slice(0, 32);
}

export function renderDescription(ev: AtlasIncidentEvent, baseUrl: string | null): string {
  const lines: string[] = [];
  if (ev.summary) lines.push(ev.summary, '');
  lines.push(`Detected by atlas (${ev.instance}) — ${ev.kind}, severity ${ev.severity}.`, `First observed: ${ev.firstObservedAt}`);
  if (ev.lastHealthyAt) lines.push(`Last known healthy: ${ev.lastHealthyAt}`);
  const e = ev.entity;
  if (e) {
    lines.push('', `Affected: ${e.name} (${e.kind})`);
    if (e.hostname) lines.push(`Host name: ${e.hostname}`);
    if (e.ips.length) lines.push(`IP: ${e.ips.join(', ')}`);
    if (e.pveNode) lines.push(`Proxmox: node ${e.pveNode}${e.vmid ? `, VMID ${e.vmid}` : ''}${e.pveCluster ? ` (${e.pveCluster})` : ''}`);
    if (e.network) lines.push(`Network: ${e.network}${e.vlan != null ? ` · VLAN ${e.vlan}` : ''}${e.uplink ? ` · ${e.uplink}` : ''}`);
  }
  if (ev.checks.length) {
    lines.push('', 'Checks:');
    for (const c of ev.checks) lines.push(`- [${c.state}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (ev.evidence.length) {
    lines.push('', 'Evidence:');
    for (const x of ev.evidence) lines.push(`- ${x}`);
  }
  if (ev.recentChanges.length) {
    lines.push('', 'Recent changes:');
    for (const x of ev.recentChanges) lines.push(`- ${x}`);
  }
  const link = ev.link ?? (baseUrl ? `${baseUrl.replace(/\/$/, '')}/incidents` : null);
  if (link) lines.push('', `atlas: ${link}`);
  return lines.join('\n').slice(0, 8000);
}

function updateNote(ev: AtlasIncidentEvent, prev: typeof s.atlasIncidentLinks.$inferSelect): string | null {
  const parts: string[] = [];
  if (ev.severity !== prev.severity) parts.push(`Severity ${prev.severity} → ${ev.severity}.`);
  if (ev.state === 'acknowledged' && prev.state !== 'acknowledged') parts.push(`Acknowledged in atlas${ev.acknowledgedBy ? ` by ${ev.acknowledgedBy}` : ''}.`);
  if (ev.persisting && !prev.persisting) parts.push('atlas still observes the problem although the ticket was resolved.');
  if ((ev.entity?.key ?? null) !== prev.entityKey) parts.push(`Affected entity: ${ev.entity?.name ?? 'none'}.`);
  const failing = ev.checks.filter((c) => c.state === 'fail' || c.state === 'warn');
  if (failing.length) parts.push(`Failing checks: ${failing.map((c) => `${c.name} (${c.state})`).join('; ')}.`);
  if (ev.evidence.length) parts.push(`Evidence: ${ev.evidence.slice(0, 6).join(' | ')}`);
  return parts.length ? `atlas update (revision ${ev.revision}, ${ev.lastObservedAt}): ${parts.join(' ')}`.slice(0, 4000) : null;
}

async function firstStatus(db: Tx, category: string, preferred: number | null): Promise<number | null> {
  if (preferred) {
    const [st] = await db.select().from(s.ticketStatuses).where(and(eq(s.ticketStatuses.id, preferred), eq(s.ticketStatuses.isActive, true)));
    if (st) return st.id;
  }
  const [st] = await db
    .select({ id: s.ticketStatuses.id })
    .from(s.ticketStatuses)
    .where(and(eq(s.ticketStatuses.category, category), eq(s.ticketStatuses.isActive, true)))
    .orderBy(sql`${s.ticketStatuses.isDefault} desc`, asc(s.ticketStatuses.sortOrder))
    .limit(1);
  return st?.id ?? null;
}

async function statusCategory(db: Tx, statusId: number): Promise<string> {
  const [st] = await db.select({ c: s.ticketStatuses.category }).from(s.ticketStatuses).where(eq(s.ticketStatuses.id, statusId));
  return st?.c ?? 'open';
}

async function ciForEntity(db: Tx, instance: string, entityKey: string | undefined, companyId: number): Promise<number | null> {
  if (!entityKey) return null;
  const [row] = await db
    .select({ ciId: s.atlasEntities.configurationItemId, companyId: s.configurationItems.companyId })
    .from(s.atlasEntities)
    .innerJoin(s.configurationItems, eq(s.configurationItems.id, s.atlasEntities.configurationItemId))
    .where(eq(s.atlasEntities.externalId, `${instance}|${entityKey}`));
  return row && row.companyId === companyId ? row.ciId : null;
}

/**
 * Applies one incident event. Idempotent: the external key is unique, the row is locked for
 * the transaction, and a revision not newer than the stored one changes nothing (replays,
 * duplicate deliveries, lost responses, out-of-order retries).
 */
export async function applyIncidentEvent(db: Db, ev: AtlasIncidentEvent, actor: string): Promise<IncidentResult & { createdTicketId?: number }> {
  const key = externalKeyOf(ev);
  const { settings } = await getAtlasSettings(db);
  if (!settings.enabled) throw new AppError(409, 'integration_disabled', 'The atlas integration is disabled in Taskora');
  if (ev.test) {
    await recordContact(db, true);
    return {
      externalKey: key,
      applied: false,
      created: false,
      test: true,
      ticket: null,
      note: settings.companyId ? 'Test event accepted: a real incident would create a ticket.' : 'Test event accepted, but no company is configured: real incidents would be refused.',
    };
  }
  if (!settings.companyId) throw new AppError(409, 'not_configured', 'Choose the company for atlas tickets in Taskora (Integrations → atlas)');
  const companyId = settings.companyId;

  const result = await db.transaction(async (tx) => {
    await tx
      .insert(s.atlasIncidentLinks)
      .values({ externalKey: key, instance: ev.instance, incidentId: String(ev.incidentId), fingerprint: ev.fingerprint, kind: ev.kind, state: 'new', severity: ev.severity, title: ev.title })
      .onConflictDoNothing({ target: s.atlasIncidentLinks.externalKey });
    const [link] = await tx.select().from(s.atlasIncidentLinks).where(eq(s.atlasIncidentLinks.externalKey, key)).for('update');
    if (!link) throw new AppError(500, 'internal', 'Incident link could not be locked');
    if (ev.revision <= link.revision) {
      return { applied: false, created: false, ticketId: link.ticketId, note: `Revision ${ev.revision} already applied (current ${link.revision})` };
    }

    const ctx = { db: tx, userId: null, origin: ATLAS_ORIGIN };
    const ciId = await ciForEntity(tx, ev.instance, ev.entity?.key, companyId);
    let ticketId = link.ticketId;
    // A ticket deleted in Taskora is not recreated for an incident that has already recovered.
    let created = false;
    let note: string | undefined;
    const ticketExists = ticketId ? !!(await tx.select({ id: s.tickets.id }).from(s.tickets).where(eq(s.tickets.id, ticketId)))[0] : false;
    if (!ticketExists) ticketId = null;

    if (!ticketId && ev.state !== 'resolved' && settings.autoCreateTickets) {
      const priorityId = settings.priorityMap[ev.severity] ?? undefined;
      const ticket = await createTicket(ctx, {
        title: ev.title,
        description: renderDescription(ev, settings.atlasBaseUrl),
        companyId,
        configurationItemId: ciId,
        queueId: settings.queueId,
        ticketTypeId: settings.ticketTypeId,
        sourceId: await monitoringSource(tx, settings.sourceId),
        assignedUserId: settings.assignedUserId,
        ...(priorityId ? { priorityId } : {}),
        tags: ['atlas', ev.kind.split('.')[0]!.slice(0, 30)],
      } as never);
      ticketId = ticket.id;
      created = true;
    } else if (!ticketId) {
      note = ev.state === 'resolved' ? 'Recovered before a ticket was created; nothing to do' : 'Automatic ticket creation is off';
    } else {
      const ticket = await getTicketRow(tx, ticketId);
      const category = await statusCategory(tx, ticket.statusId);
      const terminal = category === 'resolved' || category === 'closed';

      // Priority follows severity only while nobody changed it by hand.
      if (ev.severity !== link.severity) {
        const before = settings.priorityMap[link.severity as keyof AtlasSettings['priorityMap']] ?? null;
        const after = settings.priorityMap[ev.severity];
        if (after && (before === null || ticket.priorityId === before) && ticket.priorityId !== after) {
          await updateTicket(ctx, ticketId, { priorityId: after });
        }
      }
      if (!link.configurationItemId && ciId && !ticket.configurationItemId) {
        await updateTicket(ctx, ticketId, { configurationItemId: ciId });
      }

      const recovered = ev.state === 'resolved' && link.state !== 'resolved';
      const reopened = ev.state !== 'resolved' && link.state === 'resolved';
      if (recovered) {
        const body = `atlas verified recovery at ${ev.resolvedAt ?? ev.lastObservedAt}.${ev.evidence.length ? ` ${ev.evidence.slice(0, 4).join(' | ')}` : ''}`;
        await addTicketNote(ctx, ticketId, { body, visibility: 'internal', kind: 'automation' });
        if (settings.recoveryPolicy === 'resolve' && !terminal) {
          const statusId = await firstStatus(tx, 'resolved', settings.resolvedStatusId);
          if (statusId) await updateTicket(ctx, ticketId, { statusId, resolution: ticket.resolution ?? 'Recovered (verified by atlas).' });
        }
      } else if (reopened || (ev.persisting && !link.persisting && terminal)) {
        const body = reopened ? `atlas observes the problem again (${ev.lastObservedAt}).` : `atlas still observes the problem after the ticket was ${category} (${ev.lastObservedAt}).`;
        await addTicketNote(ctx, ticketId, { body, visibility: 'internal', kind: 'automation' });
        if (settings.reopenPolicy === 'reopen' && terminal) {
          const statusId = await firstStatus(tx, 'open', settings.reopenStatusId);
          if (statusId) await updateTicket(ctx, ticketId, { statusId });
        }
      } else if (digest(ev) !== (link.lastPayload as { digest?: string }).digest) {
        const body = updateNote(ev, link);
        if (body) await addTicketNote(ctx, ticketId, { body, visibility: 'internal', kind: 'automation' });
      }
    }

    await tx
      .update(s.atlasIncidentLinks)
      .set({
        ticketId,
        configurationItemId: ciId ?? link.configurationItemId,
        entityKey: ev.entity?.key ?? null,
        revision: ev.revision,
        state: ev.state,
        severity: ev.severity,
        persisting: ev.persisting,
        title: ev.title,
        link: ev.link ?? null,
        entity: ev.entity as unknown as Record<string, unknown> | null,
        lastPayload: { digest: digest(ev), checks: ev.checks, evidence: ev.evidence, recentChanges: ev.recentChanges, summary: ev.summary },
        firstObservedAt: new Date(ev.firstObservedAt),
        lastObservedAt: new Date(ev.lastObservedAt),
        resolvedAt: ev.resolvedAt ? new Date(ev.resolvedAt) : null,
        updatedAt: new Date(),
      })
      .where(eq(s.atlasIncidentLinks.id, link.id));
    await audit(tx, null, {
      action: created ? 'create' : 'sync',
      entityType: 'atlas_incident',
      entityId: link.id,
      summary: `${created ? 'Ticket created' : 'Updated'} from atlas incident ${key} (revision ${ev.revision}, ${ev.state}) via token "${actor}"`,
    });
    return { applied: true, created, ticketId, note };
  });
  await recordContact(db, true);
  return {
    externalKey: key,
    applied: result.applied,
    created: result.created,
    test: false,
    ticket: await ticketSnapshot(db, result.ticketId),
    ...(result.note ? { note: result.note } : {}),
    ...(result.created && result.ticketId ? { createdTicketId: result.ticketId } : {}),
  };
}

export async function incidentLookup(db: Tx, key: string) {
  const [link] = await db.select().from(s.atlasIncidentLinks).where(eq(s.atlasIncidentLinks.externalKey, key));
  if (!link) throw notFound('atlas incident');
  return { externalKey: key, revision: link.revision, state: link.state, ticket: await ticketSnapshot(db, link.ticketId) };
}

/* ------------------------------------------------------------------ feed */

const FEED_TYPES = ['status_changed', 'resolved', 'reopened', 'assigned', 'field_changed', 'note_added'];

/**
 * Lifecycle events of tickets linked to atlas incidents, after a cursor (event id). Events
 * caused by atlas itself are skipped; only internal metadata is exposed (no note bodies).
 */
export async function ticketEventsFeed(db: Tx, after: number, limit: number) {
  const rows = await db
    .select({
      id: s.ticketEvents.id,
      type: s.ticketEvents.type,
      data: s.ticketEvents.data,
      at: s.ticketEvents.createdAt,
      ticketId: s.ticketEvents.ticketId,
      externalKey: s.atlasIncidentLinks.externalKey,
      first: s.users.firstName,
      last: s.users.lastName,
    })
    .from(s.ticketEvents)
    .innerJoin(s.atlasIncidentLinks, eq(s.atlasIncidentLinks.ticketId, s.ticketEvents.ticketId))
    .leftJoin(s.users, eq(s.users.id, s.ticketEvents.userId))
    .where(
      and(
        gt(s.ticketEvents.id, after),
        inArray(s.ticketEvents.type, FEED_TYPES),
        sql`coalesce(${s.ticketEvents.data}->>'origin', '') <> ${ATLAS_ORIGIN}`,
        // Only the field changes atlas shows: priority. Other field edits are not its business.
        sql`(${s.ticketEvents.type} <> 'field_changed' or ${s.ticketEvents.data}->>'field' = 'priorityId')`,
      ),
    )
    .orderBy(asc(s.ticketEvents.id))
    .limit(limit);
  const snapshots = new Map<number, TicketSnapshot | null>();
  const events = [];
  for (const r of rows) {
    if (!snapshots.has(r.ticketId)) snapshots.set(r.ticketId, await ticketSnapshot(db, r.ticketId));
    events.push({
      id: r.id,
      externalKey: r.externalKey,
      type: r.type,
      at: r.at.toISOString(),
      actor: r.first ? `${r.first} ${r.last ?? ''}`.trim() : 'Automation',
      automation: !!(r.data as { automation?: boolean }).automation,
      ...(r.type === 'note_added' ? { visibility: (r.data as { visibility?: string }).visibility ?? 'internal' } : {}),
      ticket: snapshots.get(r.ticketId),
    });
  }
  const nextCursor = rows.length ? rows[rows.length - 1]!.id : after;
  return { events, nextCursor, more: rows.length === limit };
}

/* ------------------------------------------------------------------ CMDB */

export interface PlanItem {
  key: string;
  name: string;
  action: 'create' | 'link' | 'update' | 'propose' | 'conflict' | 'unmatched' | 'skip';
  ciId: number | null;
  ciNumber: string | null;
  note: string;
}

type EntityRow = typeof s.atlasEntities.$inferSelect;
type Incoming = AtlasInventorySync['entities'][number];

async function candidates(db: Tx, e: Incoming, companyId: number, selfId: number | null) {
  const ci = s.configurationItems;
  const linkedToOther = async (ids: number[]) => {
    if (!ids.length) return new Set<number>();
    const rows = await db
      .select({ ciId: s.atlasEntities.configurationItemId, id: s.atlasEntities.id })
      .from(s.atlasEntities)
      .where(inArray(s.atlasEntities.configurationItemId, ids));
    return new Set(rows.filter((r) => r.id !== selfId).map((r) => r.ciId!));
  };
  const strong = new Map<number, { id: number; ciNumber: string; why: string }>();
  const macs = e.macs.map((m) => m.toLowerCase());
  if (macs.length) {
    for (const r of await db.select({ id: ci.id, ciNumber: ci.ciNumber }).from(ci).where(and(eq(ci.companyId, companyId), inArray(sql`lower(${ci.macAddress})`, macs)))) {
      strong.set(r.id, { ...r, why: 'MAC address' });
    }
    // An Action1 endpoint reporting the same MAC identifies its CI too.
    for (const r of await db
      .select({ id: ci.id, ciNumber: ci.ciNumber })
      .from(s.action1Endpoints)
      .innerJoin(ci, eq(ci.id, s.action1Endpoints.configurationItemId))
      .where(and(eq(ci.companyId, companyId), inArray(sql`lower(${s.action1Endpoints.macAddress})`, macs)))) {
      strong.set(r.id, { ...r, why: 'MAC address (Action1)' });
    }
  }
  if (e.serial) {
    for (const r of await db.select({ id: ci.id, ciNumber: ci.ciNumber }).from(ci).where(and(eq(ci.companyId, companyId), sql`lower(${ci.serialNumber}) = ${e.serial.toLowerCase()}`))) {
      strong.set(r.id, { ...r, why: 'serial number' });
    }
  }
  const names = [...new Set([e.hostname, e.name].filter(Boolean).map((n) => n!.toLowerCase().split('.')[0]!).filter((n) => n.length >= 2))];
  const weak = names.length
    ? await db
        .select({ id: ci.id, ciNumber: ci.ciNumber })
        .from(ci)
        .where(and(eq(ci.companyId, companyId), or(inArray(sql`split_part(lower(${ci.hostname}), '.', 1)`, names), inArray(sql`lower(${ci.name})`, names))))
    : [];
  const taken = await linkedToOther([...strong.keys(), ...weak.map((w) => w.id)]);
  return {
    strong: [...strong.values()].filter((c) => !taken.has(c.id)),
    strongTaken: [...strong.values()].filter((c) => taken.has(c.id)),
    weak: weak.filter((w) => !taken.has(w.id) && !strong.has(w.id)),
  };
}

/** Base-seed CI type names for atlas kinds, used when no explicit mapping is configured. */
const KIND_TYPE_NAMES: Record<string, string[]> = {
  'pve-vm': ['Virtual Machine', 'Server'],
  'pve-lxc': ['Virtual Machine', 'Server'],
  'pve-node': ['Server'],
  'linux-host': ['Server'],
  nas: ['NAS', 'Server'],
  'unifi-switch': ['Network Switch'],
  'unifi-ap': ['Wireless Access Point'],
  'unifi-gateway': ['Router', 'Firewall'],
};

async function ciTypeFor(db: Tx, settings: AtlasSettings, kind: string): Promise<number | null> {
  const mapped = settings.ciTypeMap[kind];
  if (mapped) return mapped;
  for (const name of KIND_TYPE_NAMES[kind] ?? []) {
    const [t] = await db.select({ id: s.ciTypes.id }).from(s.ciTypes).where(eq(s.ciTypes.name, name));
    if (t) return t.id;
  }
  if (settings.defaultCiTypeId) return settings.defaultCiTypeId;
  const [other] = await db.select({ id: s.ciTypes.id }).from(s.ciTypes).where(eq(s.ciTypes.name, 'Other'));
  if (other) return other.id;
  const [first] = await db.select({ id: s.ciTypes.id }).from(s.ciTypes).orderBy(asc(s.ciTypes.id)).limit(1);
  return first?.id ?? null;
}

async function monitoringSource(db: Tx, configured: number | null): Promise<number | null> {
  if (configured) return configured;
  const [src] = await db.select({ id: s.ticketSources.id }).from(s.ticketSources).where(eq(s.ticketSources.name, 'Monitoring Alert'));
  return src?.id ?? null;
}

function entityData(e: Incoming): Record<string, unknown> {
  return {
    network: e.network ?? null,
    vlan: e.vlan ?? null,
    uplink: e.uplink ?? null,
    manufacturer: e.manufacturer ?? null,
    model: e.model ?? null,
    apps: e.apps,
  };
}

/** Reconciles atlas's inventory with the CMDB. `preview` (or CMDB mode off) writes nothing. */
export async function syncInventory(db: Db, body: AtlasInventorySync, actor: string) {
  const { settings } = await getAtlasSettings(db);
  if (!settings.enabled) throw new AppError(409, 'integration_disabled', 'The atlas integration is disabled in Taskora');
  const write = body.mode === 'apply' && settings.cmdbMode !== 'off';
  const companyId = settings.companyId;
  const now = new Date();
  const plan: PlanItem[] = [];
  const stats: Record<string, number> = { entities: body.entities.length, create: 0, link: 0, update: 0, propose: 0, conflict: 0, unmatched: 0, skip: 0, relations: 0, missing: 0 };

  const [run] = write
    ? await db.insert(s.syncRuns).values({ provider: ATLAS_PROVIDER, trigger: `atlas:${actor}`.slice(0, 64) }).returning()
    : [undefined];
  const keyToCi = new Map<string, number>();

  try {
    for (const e of body.entities) {
      const externalId = `${body.instance}|${e.key}`;
      const item = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(s.atlasEntities).where(eq(s.atlasEntities.externalId, externalId)).for('update');
        const obs = {
          instance: body.instance,
          entityKey: e.key,
          kind: e.kind,
          name: e.name,
          hostname: e.hostname ?? null,
          ipAddresses: e.ips,
          macAddresses: e.macs.map((m) => m.toLowerCase()),
          pveCluster: e.pveCluster ?? null,
          pveNode: e.pveNode ?? null,
          vmid: e.vmid ?? null,
          status: e.status,
          osName: e.os ?? null,
          serialNumber: e.serial ?? null,
          link: e.link ?? null,
          data: entityData(e),
          observedAt: new Date(e.observedAt),
          missingSince: null,
          lastSyncedAt: now,
        };
        let row: EntityRow | undefined = existing;
        if (write) {
          if (row) {
            const renamed = row.name !== e.name ? [...new Set([row.name, ...row.previousNames])].slice(0, 10) : row.previousNames;
            [row] = await tx.update(s.atlasEntities).set({ ...obs, previousNames: renamed }).where(eq(s.atlasEntities.id, row.id)).returning();
          } else {
            [row] = await tx.insert(s.atlasEntities).values({ externalId, ...obs }).returning();
          }
        }
        return decide(tx, settings, e, row ?? null, write, companyId);
      });
      plan.push(item);
      stats[item.action] = (stats[item.action] ?? 0) + 1;
      if (item.ciId) keyToCi.set(e.key, item.ciId);
    }

    // Already-linked entities not in this batch still count for relations.
    const linked = await db
      .select({ key: s.atlasEntities.entityKey, ciId: s.atlasEntities.configurationItemId })
      .from(s.atlasEntities)
      .where(and(eq(s.atlasEntities.instance, body.instance), sql`${s.atlasEntities.configurationItemId} is not null`));
    for (const l of linked) if (!keyToCi.has(l.key)) keyToCi.set(l.key, l.ciId!);

    if (write) {
      const seen: number[] = [];
      for (const r of body.relations) {
        const from = keyToCi.get(r.from);
        const to = keyToCi.get(r.to);
        if (!from || !to || from === to) continue;
        const [rel] = await db
          .insert(s.ciRelations)
          .values({ ciId: from, relatedCiId: to, type: r.type, source: ATLAS_PROVIDER, sourceDetail: r.detail ?? null, observedAt: now })
          .onConflictDoUpdate({
            target: [s.ciRelations.ciId, s.ciRelations.relatedCiId, s.ciRelations.type],
            // A relation a person created stays theirs; atlas only refreshes its own.
            set: { observedAt: sql`case when ${s.ciRelations.source} = ${ATLAS_PROVIDER} then ${now} else ${s.ciRelations.observedAt} end`, sourceDetail: sql`case when ${s.ciRelations.source} = ${ATLAS_PROVIDER} then ${r.detail ?? null} else ${s.ciRelations.sourceDetail} end` },
          })
          .returning({ id: s.ciRelations.id });
        if (rel) seen.push(rel.id);
        stats.relations!++;
      }
      if (body.complete) {
        // Observed relations atlas no longer sees are removed (including those of CIs an entity
        // was re-linked away from); manual ones never are, nor those another atlas instance owns.
        const ours = new Set(keyToCi.values());
        const others = await db
          .select({ ciId: s.atlasEntities.configurationItemId })
          .from(s.atlasEntities)
          .where(and(ne(s.atlasEntities.instance, body.instance), sql`${s.atlasEntities.configurationItemId} is not null`));
        const foreign = [...new Set(others.map((o) => o.ciId!))].filter((id) => !ours.has(id));
        await db
          .delete(s.ciRelations)
          .where(
            and(
              eq(s.ciRelations.source, ATLAS_PROVIDER),
              seen.length ? notInArray(s.ciRelations.id, seen) : sql`true`,
              foreign.length ? notInArray(s.ciRelations.ciId, foreign) : sql`true`,
            ),
          );
        const present = body.entities.map((e) => `${body.instance}|${e.key}`);
        const flagged = await db
          .update(s.atlasEntities)
          .set({ missingSince: now, status: 'missing' })
          .where(and(eq(s.atlasEntities.instance, body.instance), isNull(s.atlasEntities.missingSince), present.length ? notInArray(s.atlasEntities.externalId, present) : sql`true`))
          .returning({ id: s.atlasEntities.id });
        stats.missing = flagged.length;
      }
      await db
        .update(s.syncRuns)
        .set({ status: 'success', finishedAt: new Date(), stats, log: plan.filter((p) => p.action !== 'update').slice(0, 200).map((p) => ({ at: now.toISOString(), level: p.action === 'conflict' ? 'warn' : 'info', message: `${p.name}: ${p.action} — ${p.note}` })) })
        .where(eq(s.syncRuns.id, run!.id));
      await audit(db, null, { action: 'sync', entityType: 'atlas_inventory', summary: `atlas inventory sync via "${actor}": ${JSON.stringify(stats)}` });
    }
    await recordContact(db, true);
  } catch (err) {
    if (run) await db.update(s.syncRuns).set({ status: 'failed', finishedAt: new Date(), error: String((err as Error).message).slice(0, 500), stats }).where(eq(s.syncRuns.id, run.id));
    throw err;
  }
  return { mode: write ? 'apply' : 'preview', cmdbMode: settings.cmdbMode, stats, plan, runId: run?.id ?? null };
}

async function decide(tx: Tx, settings: AtlasSettings, e: Incoming, row: EntityRow | null, write: boolean, companyId: number | null): Promise<PlanItem> {
  const base = { key: e.key, name: e.name };
  const setMatch = async (status: string, note: string, ciId?: number | null, cands: number[] = []) => {
    if (write && row) {
      await tx
        .update(s.atlasEntities)
        .set({ matchStatus: status, matchNote: note.slice(0, 500), candidateCiIds: cands, ...(ciId !== undefined ? { configurationItemId: ciId } : {}) })
        .where(eq(s.atlasEntities.id, row.id));
    }
  };
  if (row?.matchStatus === 'ignored') return { ...base, action: 'skip', ciId: null, ciNumber: null, note: 'Ignored by an administrator' };

  if (row?.configurationItemId) {
    const [ci] = await tx.select().from(s.configurationItems).where(eq(s.configurationItems.id, row.configurationItemId));
    if (ci) {
      const [a1] = await tx.select({ id: s.action1Endpoints.id }).from(s.action1Endpoints).where(eq(s.action1Endpoints.configurationItemId, ci.id));
      // atlas writes CI fields only on CIs it created and Action1 does not manage.
      if (write && ci.source === ATLAS_PROVIDER && !a1) {
        const patch: Partial<typeof s.configurationItems.$inferInsert> = {};
        if (e.name !== ci.name) patch.name = e.name;
        if (e.hostname && e.hostname !== ci.hostname) patch.hostname = e.hostname;
        if (e.ips[0] && e.ips[0] !== ci.ipAddress) patch.ipAddress = e.ips[0];
        if (e.macs[0] && e.macs[0].toLowerCase() !== ci.macAddress) patch.macAddress = e.macs[0].toLowerCase();
        if (e.os && e.os !== ci.osName) patch.osName = e.os;
        patch.lastSeenAt = new Date(e.observedAt);
        await tx.update(s.configurationItems).set(patch).where(eq(s.configurationItems.id, ci.id));
      }
      // A second identity for the same device (e.g. Action1 created another CI): review, never merge.
      if (companyId) {
        const c = await candidates(tx, e, companyId, row.id);
        const other = c.strong.filter((x) => x.id !== ci.id && x.why.includes('Action1'));
        if (other.length) {
          const note = `Also managed by Action1 as ${other.map((o) => o.ciNumber).join(', ')}: review and re-link to merge identities`;
          await setMatch('conflict', note, ci.id, other.map((o) => o.id));
          return { ...base, action: 'conflict', ciId: ci.id, ciNumber: ci.ciNumber, note };
        }
      }
      if (write && row.matchStatus === 'conflict') await setMatch('linked', `Linked to ${ci.ciNumber}`, ci.id, []);
      return { ...base, action: 'update', ciId: ci.id, ciNumber: ci.ciNumber, note: a1 ? 'Observations updated (CI fields owned by Action1)' : ci.source === ATLAS_PROVIDER ? 'CI and observations updated' : 'Observations updated (CI fields kept)' };
    }
  }
  if (!companyId) {
    await setMatch('unmatched', 'Choose the atlas company in Taskora to match or create CIs');
    return { ...base, action: 'unmatched', ciId: null, ciNumber: null, note: 'No company configured' };
  }
  const c = await candidates(tx, e, companyId, row?.id ?? null);
  if (c.strong.length === 1) {
    const hit = c.strong[0]!;
    const note = `Matched by ${hit.why} to ${hit.ciNumber}`;
    await setMatch('linked', note, hit.id);
    return { ...base, action: 'link', ciId: hit.id, ciNumber: hit.ciNumber, note };
  }
  if (c.strong.length > 1) {
    const note = `${c.strong.length} CIs match by ${c.strong.map((x) => `${x.why} (${x.ciNumber})`).join(', ')}`;
    await setMatch('conflict', note, null, c.strong.map((x) => x.id));
    return { ...base, action: 'conflict', ciId: null, ciNumber: null, note };
  }
  if (c.strongTaken.length) {
    const note = `Matches ${c.strongTaken.map((x) => x.ciNumber).join(', ')}, which is already linked to another atlas entity`;
    await setMatch('conflict', note, null, c.strongTaken.map((x) => x.id));
    return { ...base, action: 'conflict', ciId: null, ciNumber: null, note };
  }
  if (c.weak.length) {
    const note = `Possible match by name: ${c.weak.map((w) => w.ciNumber).join(', ')} (confirm in Taskora)`;
    await setMatch('proposed', note, null, c.weak.map((w) => w.id));
    return { ...base, action: 'propose', ciId: null, ciNumber: c.weak[0]!.ciNumber, note };
  }
  if (settings.cmdbMode === 'link_and_create') {
    if (!write || !row) return { ...base, action: 'create', ciId: null, ciNumber: null, note: 'Would create a CI (atlas-managed)' };
    const ci = await createCiFromEntity(tx, settings, companyId, row);
    return { ...base, action: 'create', ciId: ci.id, ciNumber: ci.ciNumber, note: `Created ${ci.ciNumber}` };
  }
  await setMatch('unmatched', 'No matching CI (creation is off)');
  return { ...base, action: 'unmatched', ciId: null, ciNumber: null, note: 'No matching CI (creation is off)' };
}

export async function createCiFromEntity(tx: Tx, settings: AtlasSettings, companyId: number, row: EntityRow, userId: number | null = null) {
  const ciTypeId = await ciTypeFor(tx, settings, row.kind);
  if (!ciTypeId) throw badRequest('No CI type is configured');
  const sys = await getSystemSettings(tx);
  const ciNumber = formatNumber(sys.ciPrefix, await nextSequence(tx, 'ci'));
  const [ci] = await tx
    .insert(s.configurationItems)
    .values({
      ciNumber,
      name: row.name,
      ciTypeId,
      companyId,
      hostname: row.hostname,
      osName: row.osName,
      ipAddress: row.ipAddresses[0] ?? null,
      macAddress: row.macAddresses[0] ?? null,
      serialNumber: row.serialNumber,
      lifecycleStatus: 'active',
      lastSeenAt: row.observedAt,
      source: ATLAS_PROVIDER,
      notes: `Discovered by atlas (${row.kind}${row.pveNode ? ` on ${row.pveNode}` : ''}${row.vmid ? `, VMID ${row.vmid}` : ''}).`,
      createdById: userId,
    })
    .returning();
  await tx.update(s.atlasEntities).set({ configurationItemId: ci!.id, matchStatus: 'created', matchNote: `Created ${ciNumber}`, candidateCiIds: [] }).where(eq(s.atlasEntities.id, row.id));
  await audit(tx, null, { action: 'create', entityType: 'configuration_item', entityId: ci!.id, summary: `Created ${ciNumber} from atlas entity "${row.name}"` }, userId);
  return ci!;
}

/** Administrator decision on one entity (link / create / ignore / unlink / decommission). */
export async function resolveEntity(
  db: Db,
  id: number,
  action: { action: 'link'; configurationItemId: number } | { action: 'create' | 'ignore' | 'unlink' | 'decommission' },
  userId: number,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(s.atlasEntities).where(eq(s.atlasEntities.id, id)).for('update');
    if (!row) throw notFound('atlas entity');
    const { settings } = await getAtlasSettings(tx);
    const summary = (what: string) => audit(tx, null, { action: 'update', entityType: 'atlas_entity', entityId: id, summary: `${row.name}: ${what}` }, userId);
    switch (action.action) {
      case 'link': {
        const [ci] = await tx.select().from(s.configurationItems).where(eq(s.configurationItems.id, action.configurationItemId));
        if (!ci) throw notFound('Configuration item');
        if (settings.companyId && ci.companyId !== settings.companyId) throw badRequest('That CI belongs to another company than the atlas company');
        const [other] = await tx.select({ id: s.atlasEntities.id }).from(s.atlasEntities).where(and(eq(s.atlasEntities.configurationItemId, ci.id)));
        if (other && other.id !== id) throw badRequest(`${ci.ciNumber} is already linked to another atlas entity`);
        await tx.update(s.atlasEntities).set({ configurationItemId: ci.id, matchStatus: 'linked', matchNote: `Linked to ${ci.ciNumber} by an administrator`, candidateCiIds: [] }).where(eq(s.atlasEntities.id, id));
        // Open incident tickets follow the identity (history stays on the tickets).
        await tx.update(s.atlasIncidentLinks).set({ configurationItemId: ci.id }).where(eq(s.atlasIncidentLinks.entityKey, row.entityKey));
        await summary(`linked to ${ci.ciNumber}`);
        return { ok: true };
      }
      case 'create': {
        if (!settings.companyId) throw badRequest('Choose the atlas company first');
        if (row.configurationItemId) throw badRequest('Already linked');
        const ci = await createCiFromEntity(tx, settings, settings.companyId, row, userId);
        return { ok: true, configurationItemId: ci.id };
      }
      case 'ignore':
        await tx.update(s.atlasEntities).set({ matchStatus: 'ignored', matchNote: 'Ignored by an administrator', configurationItemId: null }).where(eq(s.atlasEntities.id, id));
        await summary('ignored');
        return { ok: true };
      case 'unlink':
        await tx.update(s.atlasEntities).set({ matchStatus: 'unmatched', matchNote: 'Unlinked by an administrator', configurationItemId: null }).where(eq(s.atlasEntities.id, id));
        await summary('unlinked');
        return { ok: true };
      case 'decommission':
        await tx.update(s.atlasEntities).set({ decommissionedAt: new Date(), status: 'decommissioned' }).where(eq(s.atlasEntities.id, id));
        await summary('marked decommissioned');
        return { ok: true };
    }
  });
}

export function freshness(row: Pick<EntityRow, 'observedAt' | 'missingSince' | 'decommissionedAt'>, staleDays: number, now = new Date()) {
  if (row.decommissionedAt) return 'decommissioned';
  if (row.missingSince) return 'missing';
  if (!row.observedAt) return 'unknown';
  return now.getTime() - row.observedAt.getTime() > staleDays * 86_400_000 ? 'stale' : 'fresh';
}

export async function listEntities(db: Tx, filter: { status?: string; q?: string; page: number; pageSize: number }) {
  const { settings } = await getAtlasSettings(db);
  const where = and(
    filter.status ? eq(s.atlasEntities.matchStatus, filter.status) : undefined,
    filter.q ? or(sql`${s.atlasEntities.name} ilike ${`%${filter.q}%`}`, sql`${s.atlasEntities.hostname} ilike ${`%${filter.q}%`}`) : undefined,
  );
  const rows = await db
    .select({ e: s.atlasEntities, ciNumber: s.configurationItems.ciNumber, ciName: s.configurationItems.name, ciSource: s.configurationItems.source, a1: s.action1Endpoints.id })
    .from(s.atlasEntities)
    .leftJoin(s.configurationItems, eq(s.configurationItems.id, s.atlasEntities.configurationItemId))
    .leftJoin(s.action1Endpoints, eq(s.action1Endpoints.configurationItemId, s.atlasEntities.configurationItemId))
    .where(where)
    .orderBy(sql`${s.atlasEntities.matchStatus} in ('conflict','proposed') desc`, asc(s.atlasEntities.name))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(s.atlasEntities).where(where);
  const counts = await db.select({ status: s.atlasEntities.matchStatus, n: sql<number>`count(*)::int` }).from(s.atlasEntities).groupBy(s.atlasEntities.matchStatus);
  return {
    data: rows.map((r) => ({
      ...r.e,
      ciNumber: r.ciNumber,
      ciName: r.ciName,
      provenance: r.e.configurationItemId ? (r.a1 ? (r.ciSource === ATLAS_PROVIDER ? 'atlas+action1' : 'action1+atlas') : r.ciSource === ATLAS_PROVIDER ? 'atlas' : `${r.ciSource}+atlas`) : 'atlas only',
      freshness: freshness(r.e, settings.staleDays),
    })),
    total,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    page: filter.page,
    pageSize: filter.pageSize,
  };
}

export async function ciAtlasPanel(db: Tx, ciId: number) {
  const { settings } = await getAtlasSettings(db);
  const [row] = await db.select().from(s.atlasEntities).where(eq(s.atlasEntities.configurationItemId, ciId));
  const incidents = await db
    .select({ key: s.atlasIncidentLinks.externalKey, title: s.atlasIncidentLinks.title, state: s.atlasIncidentLinks.state, severity: s.atlasIncidentLinks.severity, ticketId: s.atlasIncidentLinks.ticketId, at: s.atlasIncidentLinks.lastObservedAt })
    .from(s.atlasIncidentLinks)
    .where(eq(s.atlasIncidentLinks.configurationItemId, ciId))
    .orderBy(desc(s.atlasIncidentLinks.updatedAt))
    .limit(10);
  const relations = await db
    .select({ type: s.ciRelations.type, source: s.ciRelations.source, detail: s.ciRelations.sourceDetail, observedAt: s.ciRelations.observedAt, related: s.configurationItems.ciNumber, relatedName: s.configurationItems.name, relatedId: s.configurationItems.id })
    .from(s.ciRelations)
    .innerJoin(s.configurationItems, eq(s.configurationItems.id, s.ciRelations.relatedCiId))
    .where(and(eq(s.ciRelations.ciId, ciId), eq(s.ciRelations.source, ATLAS_PROVIDER)));
  return {
    entity: row ? { ...row, freshness: freshness(row, settings.staleDays) } : null,
    incidents,
    relations,
    atlasBaseUrl: settings.atlasBaseUrl,
  };
}

export async function ticketAtlasPanel(db: Tx, ticketId: number) {
  const { settings } = await getAtlasSettings(db);
  const [link] = await db.select().from(s.atlasIncidentLinks).where(eq(s.atlasIncidentLinks.ticketId, ticketId));
  if (!link) return { link: null, entity: null, atlasBaseUrl: settings.atlasBaseUrl };
  const [entity] = link.entityKey
    ? await db.select().from(s.atlasEntities).where(eq(s.atlasEntities.externalId, `${link.instance}|${link.entityKey}`))
    : [];
  return {
    link: { externalKey: link.externalKey, state: link.state, severity: link.severity, persisting: link.persisting, revision: link.revision, title: link.title, link: link.link, entity: link.entity, details: link.lastPayload, firstObservedAt: link.firstObservedAt, lastObservedAt: link.lastObservedAt, resolvedAt: link.resolvedAt, updatedAt: link.updatedAt },
    entity: entity ? { ...entity, freshness: freshness(entity, settings.staleDays) } : null,
    atlasBaseUrl: settings.atlasBaseUrl,
  };
}

/* ------------------------------------------------------------------ tokens */

export function newIntegrationToken(): { token: string; hash: string; prefix: string } {
  const token = `tki_${randomToken(32)}`;
  return { token, hash: sha256(token), prefix: token.slice(0, 8) };
}

/**
 * atlas integration contract (docs/integrations/atlas.md). atlas is a read-only homelab
 * discovery tool; it pushes incidents and inventory to Taskora with a scoped integration
 * token and reads ticket lifecycle events back from a feed. Everything received from atlas
 * is untrusted input: validated here, size-capped, and never executed or fetched.
 */
import { z } from 'zod';

/** Scopes an integration token can carry. Tokens are not users: they never get a session. */
export const INTEGRATION_SCOPES = {
  'atlas.incidents': 'Send atlas incidents (create/update the linked ticket) and read their ticket events',
  'atlas.cmdb': 'Send atlas inventory for configuration item reconciliation',
} as const;
export type IntegrationScope = keyof typeof INTEGRATION_SCOPES;
export const INTEGRATION_SCOPE_KEYS = Object.keys(INTEGRATION_SCOPES) as [IntegrationScope, ...IntegrationScope[]];

/** Stable external identity of an atlas incident: `<instance>:<incident id>`. */
export const ATLAS_EXTERNAL_KEY = /^[a-z0-9][a-z0-9._-]{0,63}:[0-9]{1,18}$/;
const instanceId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'invalid atlas instance id');
const shortText = (max: number) => z.string().trim().max(max);
const httpUrl = z
  .string()
  .max(512)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'only http(s) links');
const isoTime = z.string().datetime({ offset: true });
const mac = z.string().regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/, 'MAC as aa:bb:cc:dd:ee:ff');

export const ATLAS_SEVERITY = ['info', 'notice', 'warning'] as const;
export const ATLAS_INCIDENT_STATE = ['open', 'acknowledged', 'resolved'] as const;

/** The affected thing, as atlas knows it. Only identifiers and context, never raw output. */
export const atlasEntityRefSchema = z.object({
  key: shortText(256).min(1),
  name: shortText(200).min(1),
  kind: shortText(48),
  hostname: shortText(255).optional(),
  ips: z.array(shortText(64)).max(16).default([]),
  macs: z.array(mac).max(16).default([]),
  pveCluster: shortText(64).optional(),
  pveNode: shortText(64).optional(),
  vmid: z.number().int().positive().max(999_999_999).optional(),
  network: shortText(64).optional(),
  vlan: z.number().int().min(0).max(4094).optional(),
  uplink: shortText(128).optional(),
  link: httpUrl.optional(),
});

export const atlasIncidentEventSchema = z.object({
  instance: instanceId,
  incidentId: z.number().int().positive(),
  /** Monotonic per incident: Taskora ignores anything not newer than what it has (replays, reordering). */
  revision: z.number().int().positive(),
  fingerprint: shortText(128).min(1),
  kind: shortText(48).min(1),
  title: shortText(250).min(1),
  summary: shortText(4000).default(''),
  severity: z.enum(ATLAS_SEVERITY),
  state: z.enum(ATLAS_INCIDENT_STATE),
  /** True when the incident is still failing after the linked ticket was resolved or closed. */
  persisting: z.boolean().default(false),
  firstObservedAt: isoTime,
  lastObservedAt: isoTime,
  resolvedAt: isoTime.nullable().default(null),
  acknowledgedBy: shortText(64).nullable().default(null),
  lastHealthyAt: isoTime.nullable().default(null),
  entity: atlasEntityRefSchema.nullable().default(null),
  checks: z
    .array(z.object({ name: shortText(120), state: z.enum(['pass', 'warn', 'fail', 'unknown']), detail: shortText(400).default('') }))
    .max(20)
    .default([]),
  evidence: z.array(shortText(400)).max(20).default([]),
  recentChanges: z.array(shortText(300)).max(15).default([]),
  link: httpUrl.optional(),
  /** Test events never create a ticket; they only prove the path works. */
  test: z.boolean().default(false),
});
export type AtlasIncidentEvent = z.infer<typeof atlasIncidentEventSchema>;

export const atlasInventoryEntitySchema = atlasEntityRefSchema.extend({
  status: z.enum(['running', 'stopped', 'online', 'offline', 'unknown', 'missing']).default('unknown'),
  os: shortText(120).optional(),
  serial: shortText(120).optional(),
  manufacturer: shortText(120).optional(),
  model: shortText(120).optional(),
  observedAt: isoTime,
  apps: z
    .array(z.object({ name: shortText(120).min(1), version: shortText(64).optional() }))
    .max(80)
    .default([]),
});
export type AtlasInventoryEntity = z.infer<typeof atlasInventoryEntitySchema>;

export const ATLAS_RELATION_TYPES = ['hosted_on', 'connected_to', 'depends_on', 'runs_on'] as const;

export const atlasInventorySyncSchema = z.object({
  instance: instanceId,
  /** `preview` never writes; `apply` follows the mode configured in Taskora. */
  mode: z.enum(['preview', 'apply']).default('preview'),
  /** True when `entities` is atlas's full inventory: absent entities are then flagged missing. */
  complete: z.boolean().default(false),
  entities: z.array(atlasInventoryEntitySchema).max(500),
  relations: z
    .array(z.object({ from: shortText(256), to: shortText(256), type: z.enum(ATLAS_RELATION_TYPES), detail: shortText(120).optional() }))
    .max(2000)
    .default([]),
});
export type AtlasInventorySync = z.infer<typeof atlasInventorySyncSchema>;

export const ATLAS_CMDB_MODES = ['off', 'link_only', 'link_and_create'] as const;
export const ATLAS_RECOVERY_POLICIES = ['resolve', 'note'] as const;
export const ATLAS_REOPEN_POLICIES = ['reopen', 'note'] as const;

export const atlasSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Display-only base URL for links back to atlas (never fetched by Taskora). */
  atlasBaseUrl: httpUrl.nullable(),
  companyId: z.number().int().positive().nullable(),
  autoCreateTickets: z.boolean(),
  queueId: z.number().int().positive().nullable(),
  ticketTypeId: z.number().int().positive().nullable(),
  sourceId: z.number().int().positive().nullable(),
  assignedUserId: z.number().int().positive().nullable(),
  /** atlas severity → Taskora priority id (null = default priority). */
  priorityMap: z.object({ info: z.number().int().positive().nullable(), notice: z.number().int().positive().nullable(), warning: z.number().int().positive().nullable() }),
  recoveryPolicy: z.enum(ATLAS_RECOVERY_POLICIES),
  /** Status used when recovery resolves the ticket (null = first active "resolved" status). */
  resolvedStatusId: z.number().int().positive().nullable(),
  reopenPolicy: z.enum(ATLAS_REOPEN_POLICIES),
  reopenStatusId: z.number().int().positive().nullable(),
  cmdbMode: z.enum(ATLAS_CMDB_MODES),
  /** atlas kind → CI type id for CIs created from atlas (missing kinds use `defaultCiTypeId`). */
  ciTypeMap: z.record(z.string().max(48), z.number().int().positive()),
  defaultCiTypeId: z.number().int().positive().nullable(),
  /** Days without an observation before an atlas entity is shown as stale (never deleted). */
  staleDays: z.number().int().min(1).max(365),
});
export type AtlasSettings = z.infer<typeof atlasSettingsSchema>;

export const atlasEntityResolveSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), configurationItemId: z.number().int().positive() }),
  z.object({ action: z.literal('create') }),
  z.object({ action: z.literal('ignore') }),
  z.object({ action: z.literal('unlink') }),
  z.object({ action: z.literal('decommission') }),
]);

export const integrationTokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(INTEGRATION_SCOPE_KEYS)).min(1),
  expiresAt: isoTime.nullable().default(null),
});

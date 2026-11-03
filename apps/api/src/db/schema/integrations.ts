import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt, users } from './core.js';
import { companies, contacts } from './crm.js';
import { configurationItems, tickets } from './service.js';

/** One row per integration provider (e.g. 'action1'). Secrets are AES-256-GCM encrypted. */
export const integrations = pgTable('integrations', {
  id: id(),
  provider: text('provider').notNull().unique(),
  enabled: boolean('enabled').notNull().default(false),
  /** Non-secret settings (region, sync interval, matching options…). */
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  secretsEncrypted: text('secrets_encrypted'),
  status: text('status').notNull().default('not_configured'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastError: text('last_error'),
  nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: id(),
    provider: text('provider').notNull(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    stats: jsonb('stats').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    log: jsonb('log').$type<{ at: string; level: string; message: string }[]>().notNull().default(sql`'[]'::jsonb`),
    error: text('error'),
    triggeredById: integer('triggered_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('sync_runs_provider_idx').on(t.provider, t.startedAt)],
);

/** Log of e-mails received by the inbound mailbox poller (also used for de-duplication). */
export const inboundEmails = pgTable(
  'inbound_emails',
  {
    id: id(),
    messageId: text('message_id').notNull().unique(),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    subject: text('subject'),
    /** 'created' | 'appended' | 'rejected' | 'failed' */
    status: text('status').notNull(),
    ticketId: integer('ticket_id'),
    detail: text('detail'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('inbound_emails_received_idx').on(t.receivedAt)],
);

/** Explicit Action1 organization → Taskora company mapping (never guessed). */
export const action1Organizations = pgTable('action1_organizations', {
  id: id(),
  externalId: text('external_id').notNull().unique(),
  name: text('name').notNull(),
  companyId: integer('company_id').references(() => companies.id, { onDelete: 'set null' }),
  enabled: boolean('enabled').notNull().default(true),
  endpointCount: integer('endpoint_count').notNull().default(0),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Normalised snapshot of an Action1 managed endpoint, keyed by its persistent Action1 id. */
export const action1Endpoints = pgTable(
  'action1_endpoints',
  {
    id: id(),
    externalId: text('external_id').notNull().unique(),
    orgExternalId: text('org_external_id').notNull(),
    configurationItemId: integer('configuration_item_id').references(() => configurationItems.id, { onDelete: 'set null' }),
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    name: text('name'),
    deviceName: text('device_name'),
    osName: text('os_name'),
    platform: text('platform'),
    serialNumber: text('serial_number'),
    manufacturer: text('manufacturer'),
    ipAddress: text('ip_address'),
    macAddress: text('mac_address'),
    loggedInUser: text('logged_in_user'),
    agentStatus: text('agent_status'),
    onlineStatus: text('online_status'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastBootAt: timestamp('last_boot_at', { withTimezone: true }),
    rebootRequired: boolean('reboot_required'),
    updateStatus: text('update_status'),
    vulnerabilityStatus: text('vulnerability_status'),
    missingCriticalUpdates: integer('missing_critical_updates'),
    missingOtherUpdates: integer('missing_other_updates'),
    agentVersion: text('agent_version'),
    cpu: text('cpu'),
    ramText: text('ram_text'),
    diskText: text('disk_text'),
    missingUpdates: jsonb('missing_updates').$type<unknown[]>(),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    matchStatus: text('match_status').notNull().default('unmatched'),
    matchNote: text('match_note'),
    contactMatchNote: text('contact_match_note'),
    /** Set when the endpoint was absent from the latest full sync (never auto-deleted). */
    missingSince: timestamp('missing_since', { withTimezone: true }),
    previousNames: text('previous_names').array().notNull().default(sql`'{}'::text[]`),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('a1_endpoints_org_idx').on(t.orgExternalId),
    index('a1_endpoints_ci_idx').on(t.configurationItemId),
    uniqueIndex('a1_endpoints_ci_uq').on(t.configurationItemId).where(sql`${t.configurationItemId} is not null`),
  ],
);

/* ------------------------------------------------------------------ atlas (docs/integrations/atlas.md) */

/**
 * Scoped, revocable API tokens for machine integrations (atlas). Only a SHA-256 hash is stored;
 * the token is shown once. A token is not a user: it cannot open a session or reach routes
 * outside its scopes.
 */
export const integrationTokens = pgTable('integration_tokens', {
  id: id(),
  name: text('name').notNull(),
  /** First characters of the token, to recognise it in the list ("tki_ab12…"). */
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  scopes: text('scopes').array().notNull(),
  createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  lastUsedIp: text('last_used_ip'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * One row per atlas incident (external key `<instance>:<id>`), linking it to exactly one
 * ticket. The unique key is what makes delivery idempotent across retries and restarts.
 */
export const atlasIncidentLinks = pgTable(
  'atlas_incident_links',
  {
    id: id(),
    externalKey: text('external_key').notNull().unique(),
    instance: text('instance').notNull(),
    incidentId: text('incident_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    kind: text('kind').notNull(),
    ticketId: integer('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    configurationItemId: integer('configuration_item_id').references(() => configurationItems.id, { onDelete: 'set null' }),
    entityKey: text('entity_key'),
    /** Last revision applied; older or equal revisions are ignored (replays, reordering). */
    revision: integer('revision').notNull().default(0),
    state: text('state').notNull(),
    severity: text('severity').notNull(),
    persisting: boolean('persisting').notNull().default(false),
    title: text('title').notNull(),
    link: text('link'),
    entity: jsonb('entity').$type<Record<string, unknown> | null>(),
    lastPayload: jsonb('last_payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true }),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('atlas_links_ticket_idx').on(t.ticketId)],
);

/**
 * atlas's view of one discovered entity (VM, LXC, node, host, NAS, network device…),
 * keyed by `<instance>|<entity key>`. atlas owns these observation fields; the CI keeps its
 * own (manual / Action1) fields. Like Action1 endpoints: linked to at most one CI, flagged
 * when missing, never deleted automatically.
 */
export const atlasEntities = pgTable(
  'atlas_entities',
  {
    id: id(),
    externalId: text('external_id').notNull().unique(),
    instance: text('instance').notNull(),
    entityKey: text('entity_key').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    hostname: text('hostname'),
    ipAddresses: text('ip_addresses').array().notNull().default(sql`'{}'::text[]`),
    macAddresses: text('mac_addresses').array().notNull().default(sql`'{}'::text[]`),
    pveCluster: text('pve_cluster'),
    pveNode: text('pve_node'),
    vmid: integer('vmid'),
    status: text('status').notNull().default('unknown'),
    osName: text('os_name'),
    serialNumber: text('serial_number'),
    link: text('link'),
    /** Other atlas-owned observations (network, VLAN, uplink, apps…), shown on the CI panel. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    configurationItemId: integer('configuration_item_id').references(() => configurationItems.id, { onDelete: 'set null' }),
    /** linked | created | proposed | conflict | unmatched | ignored */
    matchStatus: text('match_status').notNull().default('unmatched'),
    matchNote: text('match_note'),
    candidateCiIds: integer('candidate_ci_ids').array().notNull().default(sql`'{}'::int[]`),
    previousNames: text('previous_names').array().notNull().default(sql`'{}'::text[]`),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    missingSince: timestamp('missing_since', { withTimezone: true }),
    decommissionedAt: timestamp('decommissioned_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('atlas_entities_ci_idx').on(t.configurationItemId),
    uniqueIndex('atlas_entities_ci_uq').on(t.configurationItemId).where(sql`${t.configurationItemId} is not null`),
    index('atlas_entities_status_idx').on(t.matchStatus),
  ],
);

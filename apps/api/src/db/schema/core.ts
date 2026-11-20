import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const id = () => integer('id').primaryKey().generatedAlwaysAsIdentity();
export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
export const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: 'number' });
export const hours = (name: string) => numeric(name, { precision: 10, scale: 2, mode: 'number' });
export const customFields = () =>
  jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`);

/* --------------------------------------------------------- users & access */

export const roles = pgTable('roles', {
  id: id(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    title: text('title'),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id),
    isActive: boolean('is_active').notNull().default(true),
    /** Technicians ("resources") can be assigned tickets, tasks and service calls. */
    isTechnician: boolean('is_technician').notNull().default(true),
    timezone: text('timezone').notNull().default('UTC'),
    hourlyCost: money('hourly_cost'),
    preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the session token; the raw token only lives in the cookie. */
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    summary: text('summary'),
    changes: jsonb('changes').$type<Record<string, unknown>>(),
    ip: text('ip'),
  },
  (t) => [index('audit_entity_idx').on(t.entityType, t.entityId), index('audit_at_idx').on(t.at)],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

/** Small raster logos (company or organization), stored in the database so backups include them. */
export const logos = pgTable(
  'logos',
  {
    entityType: text('entity_type').notNull(),
    entityId: integer('entity_id').notNull(),
    mimeType: text('mime_type').notNull(),
    /** Base64-encoded image bytes. */
    data: text('data').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('logos_entity_uq').on(t.entityType, t.entityId)],
);

/** Per-entity sequences used for human-readable numbers (TKA-000142, CI-000031…). */
export const sequences = pgTable('sequences', {
  name: text('name').primaryKey(),
  value: integer('value').notNull().default(0),
});

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    entityType: text('entity_type').notNull(),
    entityId: integer('entity_id').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    sha256: text('sha256').notNull(),
    uploadedById: integer('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_entity_idx').on(t.entityType, t.entityId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    entityType: text('entity_type'),
    entityId: integer('entity_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** E-mail delivery: null = pending (or SMTP disabled), then 'sent' / 'skipped' / 'failed'. */
    emailStatus: text('email_status'),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt), index('notifications_email_idx').on(t.emailStatus, t.createdAt)],
);

export const savedViews = pgTable('saved_views', {
  id: id(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  entity: text('entity').notNull(),
  name: text('name').notNull(),
  filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  isShared: boolean('is_shared').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Postgres-backed background job queue (claimed with FOR UPDATE SKIP LOCKED). */
export const jobs = pgTable(
  'jobs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('pending'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_pending_idx').on(t.status, t.runAt),
    uniqueIndex('jobs_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('pending','running')`),
  ],
);

/* -------------------------------------------------------- configuration */

export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: id(),
    entity: text('entity').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull(),
    options: jsonb('options').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    isRequired: boolean('is_required').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    helpText: text('help_text'),
    /** Optional tab name: fields sharing a tab are shown together as their own tab on the record (tickets). */
    tab: text('tab'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('cfd_entity_key_uq').on(t.entity, t.key)],
);

export const notificationTemplates = pgTable('notification_templates', {
  id: id(),
  event: text('event').notNull().unique(),
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const businessHours = pgTable('business_hours', {
  id: id(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  schedule: jsonb('schedule').$type<Record<string, [string, string][]>>().notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const holidays = pgTable(
  'holidays',
  {
    id: id(),
    businessHoursId: integer('business_hours_id')
      .notNull()
      .references(() => businessHours.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('holidays_bh_date_uq').on(t.businessHoursId, t.date)],
);

export const ticketStatuses = pgTable('ticket_statuses', {
  id: id(),
  name: text('name').notNull().unique(),
  category: text('category').notNull(),
  color: text('color').notNull().default('#64748b'),
  pausesSla: boolean('pauses_sla').notNull().default(false),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  isSystem: boolean('is_system').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const ticketPriorities = pgTable('ticket_priorities', {
  id: id(),
  name: text('name').notNull().unique(),
  /** 1 = most urgent. */
  level: integer('level').notNull(),
  color: text('color').notNull().default('#64748b'),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const ticketTypes = pgTable('ticket_types', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const ticketSources = pgTable('ticket_sources', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const queues = pgTable('queues', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  email: text('email'),
  defaultAssigneeId: integer('default_assignee_id').references(() => users.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const issueTypes = pgTable('issue_types', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  /** Optional restriction of the issue type to one ticket type. */
  ticketTypeId: integer('ticket_type_id').references(() => ticketTypes.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const subIssueTypes = pgTable('sub_issue_types', {
  id: id(),
  issueTypeId: integer('issue_type_id')
    .notNull()
    .references(() => issueTypes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** Optional queue tickets of this sub-issue are routed to. */
  queueId: integer('queue_id').references(() => queues.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const billingCodes = pgTable('billing_codes', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull().default('labor'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const workTypes = pgTable('work_types', {
  id: id(),
  name: text('name').notNull().unique(),
  code: text('code'),
  description: text('description'),
  billingCodeId: integer('billing_code_id').references(() => billingCodes.id, { onDelete: 'set null' }),
  hourlyRate: money('hourly_rate'),
  isBillable: boolean('is_billable').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const ciTypes = pgTable('ci_types', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  category: text('category').notNull().default('other'),
  icon: text('icon'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const slaPolicies = pgTable('sla_policies', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  businessHoursId: integer('business_hours_id').references(() => businessHours.id, { onDelete: 'set null' }),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const slaTargets = pgTable(
  'sla_targets',
  {
    id: id(),
    slaId: integer('sla_id')
      .notNull()
      .references(() => slaPolicies.id, { onDelete: 'cascade' }),
    priorityId: integer('priority_id')
      .notNull()
      .references(() => ticketPriorities.id, { onDelete: 'cascade' }),
    /** Business minutes; null = no target. */
    firstResponseMinutes: integer('first_response_minutes'),
    resolutionMinutes: integer('resolution_minutes'),
  },
  (t) => [uniqueIndex('sla_targets_uq').on(t.slaId, t.priorityId)],
);

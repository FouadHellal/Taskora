import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  ciTypes,
  createdAt,
  customFields,
  hours,
  id,
  issueTypes,
  money,
  queues,
  slaPolicies,
  subIssueTypes,
  ticketPriorities,
  ticketSources,
  ticketStatuses,
  ticketTypes,
  updatedAt,
  users,
  workTypes,
  billingCodes,
} from './core.js';
import { companies, contacts, locations } from './crm.js';

/* -------------------------------------------------------------------- CMDB */

export const products = pgTable('products', {
  id: id(),
  name: text('name').notNull(),
  sku: text('sku'),
  manufacturer: text('manufacturer'),
  ciTypeId: integer('ci_type_id').references(() => ciTypes.id, { onDelete: 'set null' }),
  description: text('description'),
  unitCost: money('unit_cost'),
  unitPrice: money('unit_price'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const configurationItems = pgTable(
  'configuration_items',
  {
    id: id(),
    ciNumber: text('ci_number').notNull().unique(),
    name: text('name').notNull(),
    ciTypeId: integer('ci_type_id')
      .notNull()
      .references(() => ciTypes.id),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    locationId: integer('location_id').references(() => locations.id, { onDelete: 'set null' }),
    productId: integer('product_id').references(() => products.id, { onDelete: 'set null' }),
    manufacturer: text('manufacturer'),
    model: text('model'),
    serialNumber: text('serial_number'),
    assetTag: text('asset_tag'),
    hostname: text('hostname'),
    osName: text('os_name'),
    osVersion: text('os_version'),
    ipAddress: text('ip_address'),
    macAddress: text('mac_address'),
    cpu: text('cpu'),
    ramGb: hours('ram_gb'),
    storageGb: hours('storage_gb'),
    purchaseDate: date('purchase_date', { mode: 'string' }),
    purchaseCost: money('purchase_cost'),
    warrantyExpiresAt: date('warranty_expires_at', { mode: 'string' }),
    supportExpiresAt: date('support_expires_at', { mode: 'string' }),
    installDate: date('install_date', { mode: 'string' }),
    lifecycleStatus: text('lifecycle_status').notNull().default('active'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** 'manual' or an integration key such as 'action1'. */
    source: text('source').notNull().default('manual'),
    notes: text('notes'),
    customFields: customFields(),
    createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ci_company_idx').on(t.companyId),
    index('ci_contact_idx').on(t.contactId),
    index('ci_serial_idx').on(sql`lower(${t.serialNumber})`),
    index('ci_hostname_idx').on(sql`lower(${t.hostname})`),
  ],
);

export const ciRelations = pgTable(
  'ci_relations',
  {
    id: id(),
    ciId: integer('ci_id')
      .notNull()
      .references(() => configurationItems.id, { onDelete: 'cascade' }),
    relatedCiId: integer('related_ci_id')
      .notNull()
      .references(() => configurationItems.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('connected_to'),
    /** Provenance: 'manual' (a person) or an integration ('atlas') that observed the relation. */
    source: text('source').notNull().default('manual'),
    /** Integration detail (e.g. switch port), shown next to the relation. */
    sourceDetail: text('source_detail'),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ci_relations_uq').on(t.ciId, t.relatedCiId, t.type)],
);

export const ciSoftware = pgTable(
  'ci_software',
  {
    id: id(),
    ciId: integer('ci_id')
      .notNull()
      .references(() => configurationItems.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: text('version'),
    publisher: text('publisher'),
    licenseKeyRef: text('license_key_ref'),
    installedAt: date('installed_at', { mode: 'string' }),
    source: text('source').notNull().default('manual'),
    createdAt: createdAt(),
  },
  (t) => [index('ci_software_ci_idx').on(t.ciId)],
);

/* --------------------------------------------------------------- contracts */

export const services = pgTable('services', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description'),
  unitPrice: money('unit_price').notNull().default(0),
  unitCost: money('unit_cost'),
  period: text('period').notNull().default('monthly'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contracts = pgTable(
  'contracts',
  {
    id: id(),
    contractNumber: text('contract_number').notNull().unique(),
    name: text('name').notNull(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status').notNull().default('active'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    slaId: integer('sla_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** Default contract applied to new tickets of the company. */
    isDefault: boolean('is_default').notNull().default(false),
    hourlyRate: money('hourly_rate'),
    fixedAmount: money('fixed_amount'),
    recurringAmount: money('recurring_amount'),
    billingPeriod: text('billing_period').notNull().default('monthly'),
    overageRate: money('overage_rate'),
    description: text('description'),
    customFields: customFields(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('contracts_company_idx').on(t.companyId)],
);

export const contractRates = pgTable(
  'contract_rates',
  {
    id: id(),
    contractId: integer('contract_id')
      .notNull()
      .references(() => contracts.id, { onDelete: 'cascade' }),
    workTypeId: integer('work_type_id')
      .notNull()
      .references(() => workTypes.id, { onDelete: 'cascade' }),
    hourlyRate: money('hourly_rate').notNull(),
  },
  (t) => [uniqueIndex('contract_rates_uq').on(t.contractId, t.workTypeId)],
);

/** Prepaid hour blocks / retainer periods purchased under a contract. */
export const contractBlocks = pgTable('contract_blocks', {
  id: id(),
  contractId: integer('contract_id')
    .notNull()
    .references(() => contracts.id, { onDelete: 'cascade' }),
  hours: hours('hours').notNull(),
  amount: money('amount'),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }),
  isPaid: boolean('is_paid').notNull().default(false),
  createdAt: createdAt(),
});

export const contractServices = pgTable('contract_services', {
  id: id(),
  contractId: integer('contract_id')
    .notNull()
    .references(() => contracts.id, { onDelete: 'cascade' }),
  serviceId: integer('service_id')
    .notNull()
    .references(() => services.id),
  quantity: hours('quantity').notNull().default(1),
  unitPrice: money('unit_price').notNull(),
  startDate: date('start_date', { mode: 'string' }),
  createdAt: createdAt(),
});

/* ---------------------------------------------------------------- projects */

export const projects = pgTable(
  'projects',
  {
    id: id(),
    projectNumber: text('project_number').notNull().unique(),
    name: text('name').notNull(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contractId: integer('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
    managerId: integer('manager_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('planning'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    estimatedHours: hours('estimated_hours'),
    budget: money('budget'),
    description: text('description'),
    customFields: customFields(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_company_idx').on(t.companyId)],
);

export const projectMilestones = pgTable('project_milestones', {
  id: id(),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  dueDate: date('due_date', { mode: 'string' }),
  description: text('description'),
  isComplete: boolean('is_complete').notNull().default(false),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
});

export const projectTasks = pgTable(
  'project_tasks',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    milestoneId: integer('milestone_id').references(() => projectMilestones.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    assignedUserId: integer('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('todo'),
    estimatedHours: hours('estimated_hours'),
    startDate: date('start_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('project_tasks_project_idx').on(t.projectId), index('project_tasks_user_idx').on(t.assignedUserId)],
);

/* ------------------------------------------------------------ service desk */

export const tickets = pgTable(
  'tickets',
  {
    id: id(),
    ticketNumber: text('ticket_number').notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    locationId: integer('location_id').references(() => locations.id, { onDelete: 'set null' }),
    configurationItemId: integer('configuration_item_id').references(() => configurationItems.id, { onDelete: 'set null' }),
    assignedUserId: integer('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    queueId: integer('queue_id').references(() => queues.id, { onDelete: 'set null' }),
    ticketTypeId: integer('ticket_type_id').references(() => ticketTypes.id, { onDelete: 'set null' }),
    issueTypeId: integer('issue_type_id').references(() => issueTypes.id, { onDelete: 'set null' }),
    subIssueTypeId: integer('sub_issue_type_id').references(() => subIssueTypes.id, { onDelete: 'set null' }),
    statusId: integer('status_id')
      .notNull()
      .references(() => ticketStatuses.id),
    priorityId: integer('priority_id')
      .notNull()
      .references(() => ticketPriorities.id),
    sourceId: integer('source_id').references(() => ticketSources.id, { onDelete: 'set null' }),
    slaId: integer('sla_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    contractId: integer('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    estimatedHours: hours('estimated_hours'),
    resolution: text('resolution'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    customFields: customFields(),
    /* SLA tracking — all deadlines computed server-side in business time. */
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }),
    resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }),
    slaPausedAt: timestamp('sla_paused_at', { withTimezone: true }),
    slaPausedMinutes: integer('sla_paused_minutes').notNull().default(0),
    firstResponseBreached: boolean('first_response_breached').notNull().default(false),
    resolutionBreached: boolean('resolution_breached').notNull().default(false),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tickets_company_idx').on(t.companyId),
    index('tickets_contact_idx').on(t.contactId),
    index('tickets_ci_idx').on(t.configurationItemId),
    index('tickets_assignee_idx').on(t.assignedUserId),
    index('tickets_queue_idx').on(t.queueId),
    index('tickets_status_idx').on(t.statusId),
    index('tickets_created_idx').on(t.createdAt),
  ],
);

export const ticketNotes = pgTable(
  'ticket_notes',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    visibility: text('visibility').notNull().default('internal'),
    /** 'note' | 'resolution' | 'automation' */
    kind: text('kind').notNull().default('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ticket_notes_ticket_idx').on(t.ticketId)],
);

/** Field-level change history and lifecycle events for the ticket timeline. */
export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('ticket_events_ticket_idx').on(t.ticketId, t.createdAt)],
);

export const ticketWatchers = pgTable(
  'ticket_watchers',
  {
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.userId] })],
);

export const ticketRelations = pgTable(
  'ticket_relations',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    relatedTicketId: integer('related_ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('related'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ticket_relations_uq').on(t.ticketId, t.relatedTicketId)],
);

export const ticketChecklistItems = pgTable(
  'ticket_checklist_items',
  {
    id: id(),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    isDone: boolean('is_done').notNull().default(false),
    doneById: integer('done_by_id').references(() => users.id, { onDelete: 'set null' }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('ticket_checklist_ticket_idx').on(t.ticketId)],
);

export const ticketTemplates = pgTable('ticket_templates', {
  id: id(),
  name: text('name').notNull().unique(),
  title: text('title'),
  description: text('description'),
  queueId: integer('queue_id').references(() => queues.id, { onDelete: 'set null' }),
  ticketTypeId: integer('ticket_type_id').references(() => ticketTypes.id, { onDelete: 'set null' }),
  issueTypeId: integer('issue_type_id').references(() => issueTypes.id, { onDelete: 'set null' }),
  subIssueTypeId: integer('sub_issue_type_id').references(() => subIssueTypes.id, { onDelete: 'set null' }),
  priorityId: integer('priority_id').references(() => ticketPriorities.id, { onDelete: 'set null' }),
  sourceId: integer('source_id').references(() => ticketSources.id, { onDelete: 'set null' }),
  estimatedHours: hours('estimated_hours'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Schedules that create tickets automatically (preventive maintenance, checks). */
export const recurringTickets = pgTable(
  'recurring_tickets',
  {
    id: id(),
    name: text('name').notNull(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    configurationItemId: integer('configuration_item_id').references(() => configurationItems.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    queueId: integer('queue_id').references(() => queues.id, { onDelete: 'set null' }),
    priorityId: integer('priority_id').references(() => ticketPriorities.id, { onDelete: 'set null' }),
    ticketTypeId: integer('ticket_type_id').references(() => ticketTypes.id, { onDelete: 'set null' }),
    issueTypeId: integer('issue_type_id').references(() => issueTypes.id, { onDelete: 'set null' }),
    subIssueTypeId: integer('sub_issue_type_id').references(() => subIssueTypes.id, { onDelete: 'set null' }),
    assignedUserId: integer('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    estimatedHours: hours('estimated_hours'),
    /** 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' */
    frequency: text('frequency').notNull().default('monthly'),
    interval: integer('interval').notNull().default(1),
    /** Due date offset after creation, in hours. */
    dueInHours: integer('due_in_hours'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastTicketId: integer('last_ticket_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('recurring_tickets_next_idx').on(t.isActive, t.nextRunAt)],
);

export const serviceCalls = pgTable(
  'service_calls',
  {
    id: id(),
    title: text('title').notNull(),
    description: text('description'),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('scheduled'),
    createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('service_calls_start_idx').on(t.startAt)],
);

export const serviceCallUsers = pgTable(
  'service_call_users',
  {
    serviceCallId: integer('service_call_id')
      .notNull()
      .references(() => serviceCalls.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.serviceCallId, t.userId] })],
);

export const serviceCallTickets = pgTable(
  'service_call_tickets',
  {
    serviceCallId: integer('service_call_id')
      .notNull()
      .references(() => serviceCalls.id, { onDelete: 'cascade' }),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.serviceCallId, t.ticketId] })],
);

/* -------------------------------------------------------------------- time */

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    invoiceNumber: text('invoice_number').notNull().unique(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    status: text('status').notNull().default('draft'),
    issueDate: date('issue_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    subtotal: money('subtotal').notNull().default(0),
    taxRate: money('tax_rate').notNull().default(0),
    taxAmount: money('tax_amount').notNull().default(0),
    total: money('total').notNull().default(0),
    currency: text('currency').notNull().default('EUR'),
    notes: text('notes'),
    createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('invoices_company_idx').on(t.companyId)],
);

export const timeEntries = pgTable(
  'time_entries',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    ticketId: integer('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    projectTaskId: integer('project_task_id').references(() => projectTasks.id, { onDelete: 'cascade' }),
    /** Denormalised for fast reporting; derived from the ticket/task. */
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    contractId: integer('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
    workTypeId: integer('work_type_id').references(() => workTypes.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMinutes: integer('duration_minutes').notNull(),
    billable: boolean('billable').notNull().default(true),
    /** Covered by a fixed-price / recurring / block contract (not billed separately). */
    contractCovered: boolean('contract_covered').notNull().default(false),
    hourlyRate: money('hourly_rate'),
    description: text('description').notNull(),
    internalNotes: text('internal_notes'),
    status: text('status').notNull().default('submitted'),
    approvedById: integer('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    invoiceId: integer('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('time_entries_user_idx').on(t.userId, t.startedAt),
    index('time_entries_ticket_idx').on(t.ticketId),
    index('time_entries_company_idx').on(t.companyId, t.startedAt),
    index('time_entries_contract_idx').on(t.contractId),
  ],
);

export const activeTimers = pgTable('active_timers', {
  id: id(),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  ticketId: integer('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  projectTaskId: integer('project_task_id').references(() => projectTasks.id, { onDelete: 'cascade' }),
  description: text('description'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
});

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    ticketId: integer('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'set null' }),
    contractId: integer('contract_id').references(() => contracts.id, { onDelete: 'set null' }),
    billingCodeId: integer('billing_code_id').references(() => billingCodes.id, { onDelete: 'set null' }),
    expenseDate: date('expense_date', { mode: 'string' }).notNull(),
    description: text('description').notNull(),
    amount: money('amount').notNull(),
    billable: boolean('billable').notNull().default(true),
    invoiceId: integer('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('expenses_company_idx').on(t.companyId)],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: id(),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    description: text('description').notNull(),
    quantity: hours('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    amount: money('amount').notNull(),
    timeEntryId: integer('time_entry_id').references((): AnyPgColumn => timeEntries.id, { onDelete: 'set null' }),
    expenseId: integer('expense_id').references(() => expenses.id, { onDelete: 'set null' }),
    contractServiceId: integer('contract_service_id').references(() => contractServices.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('invoice_lines_invoice_idx').on(t.invoiceId)],
);

/* --------------------------------------------------------------- knowledge */

export const kbCategories = pgTable('kb_categories', {
  id: id(),
  name: text('name').notNull(),
  parentId: integer('parent_id').references((): AnyPgColumn => kbCategories.id, { onDelete: 'set null' }),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const kbArticles = pgTable(
  'kb_articles',
  {
    id: id(),
    articleNumber: text('article_number').notNull().unique(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    categoryId: integer('category_id').references(() => kbCategories.id, { onDelete: 'set null' }),
    /** Set for company-specific documentation; null for the general knowledge base. */
    companyId: integer('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    visibility: text('visibility').notNull().default('internal'),
    status: text('status').notNull().default('draft'),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: integer('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    views: integer('views').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('kb_articles_company_idx').on(t.companyId)],
);

export const kbArticleTickets = pgTable(
  'kb_article_tickets',
  {
    articleId: integer('article_id')
      .notNull()
      .references(() => kbArticles.id, { onDelete: 'cascade' }),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.articleId, t.ticketId] })],
);

/* -------------------------------------------------------------- automation */

export const workflowRules = pgTable('workflow_rules', {
  id: id(),
  name: text('name').notNull(),
  description: text('description'),
  trigger: text('trigger').notNull(),
  delayMinutes: integer('delay_minutes'),
  conditions: jsonb('conditions').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  actions: jsonb('actions').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  isActive: boolean('is_active').notNull().default(true),
  stopProcessing: boolean('stop_processing').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  executionCount: integer('execution_count').notNull().default(0),
  lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
  createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowExecutions = pgTable(
  'workflow_executions',
  {
    id: id(),
    ruleId: integer('rule_id')
      .notNull()
      .references(() => workflowRules.id, { onDelete: 'cascade' }),
    ticketId: integer('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    status: text('status').notNull(),
    /** Prevents status-age rules from firing twice for the same status period. */
    dedupeKey: text('dedupe_key'),
    result: jsonb('result').$type<unknown>(),
    error: text('error'),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wf_exec_rule_idx').on(t.ruleId, t.executedAt),
    uniqueIndex('wf_exec_dedupe_uq').on(t.ruleId, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);

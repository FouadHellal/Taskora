import { z } from 'zod';
import {
  ACTIVITY_TYPE,
  BILLING_PERIOD,
  SERVICE_QUANTITY_SOURCE,
  CI_LIFECYCLE,
  CI_RELATION_TYPE,
  COMPANY_TYPE,
  CONTRACT_STATUS,
  CONTRACT_TYPE,
  CUSTOM_FIELD_ENTITY,
  CUSTOM_FIELD_TYPE,
  INVOICE_STATUS,
  KB_STATUS,
  KB_VISIBILITY,
  NOTE_VISIBILITY,
  OPPORTUNITY_STAGE,
  PROJECT_STATUS,
  SERVICE_CALL_STATUS,
  TASK_STATUS,
  TICKET_RELATION_TYPE,
  TIME_ENTRY_STATUS,
  WORKFLOW_ACTION,
  WORKFLOW_FIELDS,
  WORKFLOW_OPERATOR,
  WORKFLOW_TRIGGER,
  CI_CATEGORY,
  STATUS_CATEGORY,
  ACTION1_REGIONS,
} from './enums.js';

/* ------------------------------------------------------------------ helpers */

/** Optional text: trims, and turns empty strings into null. */
export const optText = (max = 255) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v));

export const reqText = (max = 255) => z.string().trim().min(1, 'Required').max(max);

/** Optional foreign key id. Accepts numbers, numeric strings, '' and null. */
export const optId = z
  .union([z.number().int().positive(), z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Invalid reference' });
      return z.NEVER;
    }
    return n;
  });

export const reqId = z.coerce.number().int().positive({ message: 'Required' });

/** ISO date (YYYY-MM-DD) or null. */
export const optDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .nullish()
  .or(z.literal(''))
  .transform((v) => (v ? v : null));

/** ISO datetime string or null. */
export const optDateTime = z
  .string()
  .nullish()
  .or(z.literal(''))
  .transform((v, ctx) => {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Invalid date/time' });
      return z.NEVER;
    }
    return d.toISOString();
  });

export const optNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: 'custom', message: 'Must be a number' });
      return z.NEVER;
    }
    return n;
  });

export const customFieldsSchema = z.record(z.string(), z.unknown()).optional().default({});

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.string().max(64).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().max(200).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/* --------------------------------------------------------------------- auth */

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(256)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'Use letters and numbers');

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(256),
});

export const setupSchema = z.object({
  setupToken: z.string().min(1, 'Required'),
  organizationName: reqText(120),
  firstName: reqText(80),
  lastName: reqText(80),
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
  timezone: z.string().min(1).max(64).default('UTC'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

/* -------------------------------------------------------------- users/roles */

export const userCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  firstName: reqText(80),
  lastName: reqText(80),
  title: optText(120),
  phone: optText(60),
  roleId: reqId,
  isActive: z.boolean().default(true),
  isTechnician: z.boolean().default(true),
  timezone: z.string().max(64).default('UTC'),
  hourlyCost: optNumber,
  password: passwordSchema,
});
export const userUpdateSchema = userCreateSchema.omit({ password: true }).partial().extend({
  password: passwordSchema.optional(),
});

export const roleSchema = z.object({
  name: reqText(80),
  description: optText(255),
  permissions: z.array(z.string()).default([]),
});

/* ---------------------------------------------------------------------- CRM */

const address = {
  address1: optText(200),
  address2: optText(200),
  city: optText(100),
  state: optText(100),
  postalCode: optText(30),
  country: optText(100),
};

/** Free mail providers: a domain like gmail.com never identifies one company. */
export const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com',
  'yahoo.com', 'yahoo.fr', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.fr', 'gmx.de', 'mail.com',
  'proton.me', 'protonmail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'laposte.net', 'orange.fr', 'free.fr', 'sfr.fr', 'wanadoo.fr', 'web.de', 't-online.de',
]);
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** "@LesAures.com", "https://www.lesaures.com/" → "lesaures.com". */
export function normalizeDomain(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^.*@/, '')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

export const companySchema = z.object({
  name: reqText(200),
  accountNumber: optText(40),
  type: z.enum(COMPANY_TYPE.values).default('customer'),
  isActive: z.boolean().default(true),
  industry: optText(100),
  website: optText(255),
  phone: optText(60),
  email: z.string().trim().email().nullish().or(z.literal('')).transform((v) => v || null),
  /** E-mail domains of the company ("lesaures.com"): incoming e-mail from them opens tickets for it. */
  emailDomains: z
    .array(z.string())
    .max(20)
    .default([])
    .transform((list) => [...new Set(list.map(normalizeDomain).filter(Boolean))])
    .refine((list) => list.every((d) => DOMAIN_RE.test(d)), 'Use domains such as example.com')
    .refine((list) => !list.some((d) => PUBLIC_MAIL_DOMAINS.has(d)), 'Public mail domains (gmail.com, outlook.com…) cannot belong to a company; add the people as contacts instead'),
  ...address,
  parentCompanyId: optId,
  primaryContactId: optId,
  accountManagerId: optId,
  defaultSlaId: optId,
  notes: optText(10000),
  customFields: customFieldsSchema,
});
export type CompanyInput = z.input<typeof companySchema>;

export const locationSchema = z.object({
  companyId: reqId,
  name: reqText(120),
  ...address,
  phone: optText(60),
  isPrimary: z.boolean().default(false),
  isActive: z.boolean().default(true),
  notes: optText(5000),
});

export const contactSchema = z.object({
  companyId: reqId,
  locationId: optId,
  firstName: reqText(80),
  lastName: reqText(80),
  title: optText(120),
  department: optText(120),
  email: z.string().trim().email().nullish().or(z.literal('')).transform((v) => (v ? v.toLowerCase() : null)),
  phone: optText(60),
  mobile: optText(60),
  isActive: z.boolean().default(true),
  isPrimary: z.boolean().default(false),
  notes: optText(10000),
  customFields: customFieldsSchema,
});

export const activitySchema = z.object({
  companyId: reqId,
  contactId: optId,
  type: z.enum(ACTIVITY_TYPE.values).default('note'),
  subject: reqText(200),
  body: optText(20000),
  occurredAt: optDateTime,
});

export const opportunitySchema = z.object({
  companyId: reqId,
  contactId: optId,
  ownerId: optId,
  title: reqText(200),
  stage: z.enum(OPPORTUNITY_STAGE.values).default('qualification'),
  amount: optNumber,
  probability: z.coerce.number().int().min(0).max(100).default(10),
  expectedCloseDate: optDate,
  description: optText(10000),
});

/* ----------------------------------------------------------- service desk */

export const ticketSchema = z.object({
  title: reqText(255),
  description: optText(50000),
  companyId: reqId,
  contactId: optId,
  locationId: optId,
  configurationItemId: optId,
  assignedUserId: optId,
  queueId: optId,
  ticketTypeId: optId,
  issueTypeId: optId,
  subIssueTypeId: optId,
  statusId: optId,
  priorityId: optId,
  sourceId: optId,
  slaId: optId,
  contractId: optId,
  projectId: optId,
  dueAt: optDateTime,
  estimatedHours: optNumber,
  resolution: optText(50000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  customFields: customFieldsSchema,
});
export type TicketInput = z.input<typeof ticketSchema>;
export const ticketUpdateSchema = ticketSchema.partial();

export const ticketNoteSchema = z.object({
  body: reqText(50000),
  visibility: z.enum(NOTE_VISIBILITY.values).default('internal'),
  /** Optional status change applied together with the note. */
  statusId: optId,
  /** E-mail a customer-visible note to the ticket contact (requires SMTP). */
  notifyContact: z.boolean().default(false),
});

export const ticketBulkSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  changes: z
    .object({
      statusId: optId,
      priorityId: optId,
      queueId: optId,
      assignedUserId: optId,
    })
    .partial(),
});

export const ticketRelationSchema = z.object({
  relatedTicketId: reqId,
  type: z.enum(TICKET_RELATION_TYPE.values).default('related'),
});

export const ticketTemplateSchema = z.object({
  name: reqText(120),
  title: optText(255),
  description: optText(20000),
  queueId: optId,
  ticketTypeId: optId,
  issueTypeId: optId,
  subIssueTypeId: optId,
  priorityId: optId,
  sourceId: optId,
  estimatedHours: optNumber,
  isActive: z.boolean().default(true),
});

export const savedViewSchema = z.object({
  name: reqText(80),
  entity: z.enum(['tickets', 'configuration_items', 'companies']).default('tickets'),
  filters: z.record(z.string(), z.unknown()).default({}),
  isShared: z.boolean().default(false),
});

export const serviceCallSchema = z.object({
  title: reqText(200),
  description: optText(5000),
  companyId: reqId,
  startAt: z.string().min(1),
  endAt: z.string().min(1),
  status: z.enum(SERVICE_CALL_STATUS.values).default('scheduled'),
  userIds: z.array(z.number().int().positive()).default([]),
  ticketIds: z.array(z.number().int().positive()).default([]),
});

/* -------------------------------------------------------------------- time */

export const timeEntryBaseSchema = z.object({
    userId: optId,
    ticketId: optId,
    projectTaskId: optId,
    workTypeId: optId,
    contractId: optId,
    startedAt: z.string().min(1, 'Required'),
    endedAt: optDateTime,
    durationMinutes: z.coerce.number().int().min(1, 'Minimum 1 minute').max(24 * 60, 'Maximum 24 hours'),
    billable: z.boolean().default(true),
    description: reqText(10000),
    internalNotes: optText(10000),
});
export const timeEntrySchema = timeEntryBaseSchema.refine((v) => v.ticketId || v.projectTaskId, {
  message: 'Link the entry to a ticket or a project task',
  path: ['ticketId'],
});

export const timerStartSchema = z.object({
  ticketId: optId,
  projectTaskId: optId,
  description: optText(500),
});

export const timeApprovalSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  status: z.enum(['approved', 'rejected']),
});

export const timeStatusSchema = z.enum(TIME_ENTRY_STATUS.values);

/* -------------------------------------------------------------------- CMDB */

export const ciSchema = z.object({
  name: reqText(200),
  ciTypeId: reqId,
  companyId: reqId,
  contactId: optId,
  locationId: optId,
  productId: optId,
  manufacturer: optText(120),
  model: optText(120),
  serialNumber: optText(120),
  assetTag: optText(60),
  hostname: optText(255),
  osName: optText(120),
  osVersion: optText(120),
  ipAddress: optText(64),
  macAddress: optText(64),
  cpu: optText(200),
  ramGb: optNumber,
  storageGb: optNumber,
  purchaseDate: optDate,
  purchaseCost: optNumber,
  warrantyExpiresAt: optDate,
  supportExpiresAt: optDate,
  installDate: optDate,
  lifecycleStatus: z.enum(CI_LIFECYCLE.values).default('active'),
  notes: optText(20000),
  customFields: customFieldsSchema,
});
export type CiInput = z.input<typeof ciSchema>;

export const ciRelationSchema = z.object({
  relatedCiId: reqId,
  type: z.enum(CI_RELATION_TYPE.values).default('connected_to'),
});

export const ciSoftwareSchema = z.object({
  name: reqText(200),
  version: optText(80),
  publisher: optText(120),
  licenseKeyRef: optText(120),
  installedAt: optDate,
});

export const productSchema = z.object({
  name: reqText(200),
  sku: optText(80),
  manufacturer: optText(120),
  ciTypeId: optId,
  description: optText(5000),
  unitCost: optNumber,
  unitPrice: optNumber,
  isActive: z.boolean().default(true),
});

/* --------------------------------------------------- contracts and billing */

export const contractSchema = z.object({
  name: reqText(200),
  companyId: reqId,
  type: z.enum(CONTRACT_TYPE.values),
  status: z.enum(CONTRACT_STATUS.values).default('active'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  endDate: optDate,
  slaId: optId,
  contactId: optId,
  isDefault: z.boolean().default(false),
  hourlyRate: optNumber,
  fixedAmount: optNumber,
  recurringAmount: optNumber,
  billingPeriod: z.enum(BILLING_PERIOD.values).default('monthly'),
  overageRate: optNumber,
  perTicketRate: optNumber,
  /** Renews for the same term at the end date (shown to the client). */
  autoRenew: z.boolean().default(false),
  /** Shown to company managers in the client portal (Billing). */
  portalVisible: z.boolean().default(true),
  description: optText(10000),
  customFields: customFieldsSchema,
});

export const contractRateSchema = z.object({ workTypeId: reqId, hourlyRate: z.coerce.number().min(0) });
export const contractBlockSchema = z.object({
  hours: z.coerce.number().positive(),
  amount: optNumber,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: optDate,
  isPaid: z.boolean().default(false),
});
export const contractServiceSchema = z.object({
  serviceId: reqId,
  quantity: z.coerce.number().min(0).default(1),
  /** Quantity follows the service's count (devices of a type, or users) automatically. */
  autoQuantity: z.boolean().default(false),
  unitPrice: optNumber,
  startDate: optDate,
  /** Last billed day (inclusive); null = until the contract ends. */
  endDate: optDate,
});
/** Work types that stay billable even when the contract would cover the time. */
export const contractExclusionsSchema = z.object({ workTypeIds: z.array(reqId).max(200) });

export const serviceSchema = z.object({
  name: reqText(200),
  description: optText(5000),
  unitPrice: z.coerce.number().min(0).default(0),
  unitCost: optNumber,
  period: z.enum(BILLING_PERIOD.values).default('monthly'),
  /** Per-device / per-user pricing: what contract lines count when "count automatically" is on. */
  quantitySource: z.enum(SERVICE_QUANTITY_SOURCE.values).default('manual'),
  ciTypeId: optId,
  isActive: z.boolean().default(true),
});

export const expenseSchema = z.object({
  companyId: reqId,
  ticketId: optId,
  projectId: optId,
  contractId: optId,
  billingCodeId: optId,
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: reqText(500),
  amount: z.coerce.number().min(0),
  billable: z.boolean().default(true),
});

export const invoiceDraftSchema = z.object({
  companyId: reqId,
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  includeTime: z.boolean().default(true),
  includeExpenses: z.boolean().default(true),
  includeRecurring: z.boolean().default(true),
  /** Omitted/empty = the system default tax rate. */
  taxRate: z.union([z.literal(''), z.null(), z.coerce.number().min(0).max(100)]).optional().transform((v) => (v === '' || v === null || v === undefined ? undefined : v)),
  notes: optText(5000),
});

export const invoiceUpdateSchema = z.object({
  status: z.enum(INVOICE_STATUS.values).optional(),
  dueDate: optDate.optional(),
  notes: optText(5000).optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
});

export const invoiceLineSchema = z.object({
  description: reqText(500),
  quantity: z.coerce.number(),
  unitPrice: z.coerce.number(),
});

/* ---------------------------------------------------------------- projects */

export const projectSchema = z.object({
  name: reqText(200),
  companyId: reqId,
  contractId: optId,
  managerId: optId,
  status: z.enum(PROJECT_STATUS.values).default('planning'),
  startDate: optDate,
  endDate: optDate,
  estimatedHours: optNumber,
  budget: optNumber,
  description: optText(20000),
  customFields: customFieldsSchema,
});

export const milestoneSchema = z.object({
  name: reqText(200),
  dueDate: optDate,
  description: optText(5000),
  isComplete: z.boolean().default(false),
});

export const projectTaskSchema = z.object({
  title: reqText(200),
  description: optText(20000),
  milestoneId: optId,
  assignedUserId: optId,
  status: z.enum(TASK_STATUS.values).default('todo'),
  estimatedHours: optNumber,
  startDate: optDate,
  dueDate: optDate,
});

/* --------------------------------------------------------------- knowledge */

export const kbCategorySchema = z.object({
  name: reqText(120),
  parentId: optId,
  description: optText(1000),
});

export const kbArticleSchema = z.object({
  title: reqText(255),
  body: z.string().max(200000).default(''),
  categoryId: optId,
  companyId: optId,
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  visibility: z.enum(KB_VISIBILITY.values).default('internal'),
  status: z.enum(KB_STATUS.values).default('draft'),
});

/* ---------------------------------------------------------------- settings */

export const ticketStatusSchema = z.object({
  name: reqText(60),
  category: z.enum(STATUS_CATEGORY.values),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  pausesSla: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

export const prioritySchema = z.object({
  name: reqText(60),
  level: z.coerce.number().int().min(1).max(10),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

export const namedSettingSchema = z.object({
  name: reqText(120),
  description: optText(1000),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

export const queueSchema = namedSettingSchema.extend({
  email: optText(255),
  defaultAssigneeId: optId,
});

export const issueTypeSchema = namedSettingSchema.extend({ ticketTypeId: optId });
export const subIssueTypeSchema = namedSettingSchema.extend({ issueTypeId: reqId, queueId: optId });

export const workTypeSchema = namedSettingSchema.extend({
  code: optText(40),
  billingCodeId: optId,
  hourlyRate: optNumber,
  isBillable: z.boolean().default(true),
});

export const billingCodeSchema = namedSettingSchema.extend({
  code: reqText(40),
  kind: z.enum(['labor', 'expense', 'material', 'service']).default('labor'),
});

export const ciTypeSchema = namedSettingSchema.extend({
  category: z.enum(CI_CATEGORY.values).default('other'),
  icon: optText(40),
});

const timeRange = z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)]);
export const weekScheduleSchema = z.object({
  mon: z.array(timeRange).default([]),
  tue: z.array(timeRange).default([]),
  wed: z.array(timeRange).default([]),
  thu: z.array(timeRange).default([]),
  fri: z.array(timeRange).default([]),
  sat: z.array(timeRange).default([]),
  sun: z.array(timeRange).default([]),
});
export type WeekSchedule = z.infer<typeof weekScheduleSchema>;

export const businessHoursSchema = z.object({
  name: reqText(120),
  timezone: z.string().min(1).max(64),
  schedule: weekScheduleSchema,
  isDefault: z.boolean().default(false),
});

export const holidaySchema = z.object({
  businessHoursId: reqId,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: reqText(120),
});

export const slaPolicySchema = z.object({
  name: reqText(120),
  description: optText(1000),
  businessHoursId: optId,
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  targets: z
    .array(
      z.object({
        priorityId: reqId,
        firstResponseMinutes: z.coerce.number().int().min(1).nullable(),
        resolutionMinutes: z.coerce.number().int().min(1).nullable(),
      }),
    )
    .default([]),
});

export const customFieldSchema = z.object({
  entity: z.enum(CUSTOM_FIELD_ENTITY.values),
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,40}$/, 'Lowercase letters, digits and underscores'),
  label: reqText(80),
  type: z.enum(CUSTOM_FIELD_TYPE.values),
  options: z.array(z.string().trim().min(1)).default([]),
  isRequired: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
  helpText: optText(255),
  /** Group the field under its own tab on the record (e.g. "Hardware", "Onboarding"). */
  tab: optText(40),
});

export const notificationTemplateSchema = z.object({
  event: reqText(80),
  name: reqText(120),
  subject: reqText(255),
  body: reqText(20000),
  isActive: z.boolean().default(true),
});

/* -------------------------------------------------------------- automation */

export const workflowConditionSchema = z.object({
  field: z.enum(WORKFLOW_FIELDS.values),
  operator: z.enum(WORKFLOW_OPERATOR.values),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])), z.null()]).optional(),
});
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;

export const workflowActionSchema = z.object({
  type: z.enum(WORKFLOW_ACTION.values),
  value: z.union([z.string(), z.number(), z.null()]).optional(),
});
export type WorkflowAction = z.infer<typeof workflowActionSchema>;

export const workflowRuleSchema = z.object({
  name: reqText(120),
  description: optText(1000),
  trigger: z.enum(WORKFLOW_TRIGGER.values),
  /** For ticket.status_age: minutes the ticket must remain in the matching status. */
  delayMinutes: z.coerce.number().int().min(0).max(525600).nullish().transform((v) => v ?? null),
  conditions: z.array(workflowConditionSchema).default([]),
  actions: z.array(workflowActionSchema).min(1, 'Add at least one action'),
  isActive: z.boolean().default(true),
  stopProcessing: z.boolean().default(false),
  sortOrder: z.coerce.number().int().default(0),
});

/* ------------------------------------------------------------- integration */

export const action1SettingsSchema = z.object({
  enabled: z.boolean().default(false),
  region: z.enum(ACTION1_REGIONS.values).default('eu'),
  /** Leave empty to keep the stored value. */
  clientId: z.string().trim().max(255).optional(),
  clientSecret: z.string().trim().max(1024).optional(),
  syncIntervalMinutes: z.coerce.number().int().min(15).max(1440).default(60),
  autoCreateCis: z.boolean().default(true),
  matchBySerial: z.boolean().default(true),
  matchByHostname: z.boolean().default(false),
  matchContacts: z.boolean().default(true),
  defaultCiTypeId: optId,
});

export const action1OrgMappingSchema = z.object({
  companyId: optId,
  enabled: z.boolean().default(true),
});

export const action1EndpointResolveSchema = z.object({
  action: z.enum(['link', 'create', 'ignore', 'unignore']),
  configurationItemId: optId,
});

/* ------------------------------------------------------------- TP-Link Omada */

export const OMADA_DEVICE_KINDS = ['ap', 'switch', 'gateway'] as const;

export const omadaSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Controller address, e.g. https://192.168.0.10:8043 (on-premise) or the cloud northbound URL. */
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\/[^\s/]+(:\d+)?(\/.*)?$/i.test(v), 'Use https://host:port')
    .transform((v) => v.replace(/\/+$/, ''))
    .default(''),
  /** Read from the controller (/api/info) when empty. */
  omadacId: z.string().trim().max(100).default(''),
  /** Leave empty to keep the stored value. */
  clientId: z.string().trim().max(255).optional(),
  clientSecret: z.string().trim().max(1024).optional(),
  /** Controllers usually have a self-signed certificate: off by default. */
  verifyTls: z.boolean().default(false),
  syncIntervalMinutes: z.coerce.number().int().min(5).max(1440).default(15),
  /** Create a CI for each device of a mapped site that matches no existing CI. */
  autoCreateCis: z.boolean().default(true),
  /** Which Omada devices become CIs. */
  deviceKinds: z.array(z.enum(OMADA_DEVICE_KINDS)).min(1).default(['ap']),
});

export const omadaSiteMappingSchema = z.object({
  companyId: optId,
  enabled: z.boolean().default(true),
});

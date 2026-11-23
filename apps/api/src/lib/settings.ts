import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client.js';
import { systemSettings } from '../db/schema/index.js';

export const systemSettingsSchema = z.object({
  organizationName: z.string().trim().min(1).max(120).default('Taskora'),
  timezone: z.string().min(1).max(64).default('UTC'),
  currency: z.string().length(3).default('EUR'),
  /** Default interface language for users who have not chosen one (en, fr, nl, de, es). */
  language: z.enum(['en', 'fr', 'nl', 'de', 'es']).catch('en').default('en'),
  /** Date display format ('auto' follows the browser locale). */
  dateFormat: z.enum(['auto', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy']).catch('auto').default('auto'),
  /** Open tickets in their own browser window (like Autotask) unless a user chooses otherwise. */
  ticketsOpenInWindow: z.boolean().default(true),
  /** Default tax rate (%) proposed on new invoices. */
  defaultTaxRate: z.coerce.number().min(0).max(100).default(0),
  ticketPrefix: z.string().trim().max(10).default('TKA-'),
  ciPrefix: z.string().trim().max(10).default('CI-'),
  contractPrefix: z.string().trim().max(10).default('CTR-'),
  projectPrefix: z.string().trim().max(10).default('PRJ-'),
  invoicePrefix: z.string().trim().max(10).default('INV-'),
  kbPrefix: z.string().trim().max(10).default('KB-'),
  defaultWorkTypeId: z.number().int().positive().nullable().default(null),
  /** Minutes before an SLA deadline when the ticket is flagged "at risk". */
  slaWarningMinutes: z.coerce.number().int().min(5).max(1440).default(60),
  /** Time-entry rounding increment in minutes (1 = none). */
  timeRoundingMinutes: z.coerce.number().int().min(1).max(60).default(1),
  requireTimeApproval: z.boolean().default(false),
  invoicePaymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  invoiceFooter: z.string().max(2000).default(''),
  companyAddress: z.string().max(1000).default(''),
  /** Company used for e-mail tickets from unknown senders (null = reject them). */
  inboundEmailCompanyId: z.number().int().positive().nullable().default(null),
  /** Queue for tickets created from e-mail. */
  inboundEmailQueueId: z.number().int().positive().nullable().default(null),
  /** The worker writes a full backup to BACKUP_DIR on this schedule. */
  autoBackupEnabled: z.boolean().default(true),
  autoBackupIntervalHours: z.coerce.number().int().min(1).max(24 * 30).default(24),
  /** Automatic backups kept on the server (older ones are deleted; manual ones are kept). */
  backupRetention: z.coerce.number().int().min(1).max(365).default(7),
  /** Set when the organization logo changes; used to bust the browser cache. */
  logoUpdatedAt: z.string().nullable().default(null),
  /* Client portal (/portal): what the companies' contacts can see and do. */
  portalEnabled: z.boolean().default(true),
  /** Shown on the client portal home page (Markdown). */
  portalWelcome: z.string().max(4000).default(''),
  /** Show who worked on a ticket, when and how long (time entry descriptions, never internal notes). */
  portalShowTime: z.boolean().default(true),
  /** Show the company's devices (configuration items). */
  portalShowDevices: z.boolean().default(true),
  /** Show contracts and hour-block balances to portal managers. */
  portalShowContracts: z.boolean().default(true),
  /** Let contacts write and edit their company documentation. */
  portalAllowDocs: z.boolean().default(true),
  /** Let contacts choose the priority of a new request. */
  portalAllowPriority: z.boolean().default(true),
  /** Let contacts attach files to their requests. */
  portalAllowAttachments: z.boolean().default(true),
  /** Show monthly reports to portal managers. */
  portalShowReports: z.boolean().default(true),
  /** Show the service agreement, prices and invoices to portal managers. */
  portalShowBilling: z.boolean().default(true),
  /* E-mail notifications (sent through Administration → E-mail). */
  /** IT team addresses alerted about every new ticket (comma separated). */
  staffAlertEmails: z.string().max(2000).default(''),
  /** Alert those addresses when a ticket is created (by a client or the IT team). */
  staffAlertOnNewTicket: z.boolean().default(true),
  /** Alert those addresses when a client replies in the portal. */
  staffAlertOnClientReply: z.boolean().default(true),
  /** Master switch for e-mails to clients (confirmation, resolved, monthly report). Each contact can still opt out. */
  clientEmailsEnabled: z.boolean().default(true),
  /** A sender from a company's e-mail domain who is not a contact yet becomes one. */
  inboundCreateContacts: z.boolean().default(true),
  /** Add an internal "what is this about" note to every new ticket. */
  ticketInsightsEnabled: z.boolean().default(true),
  /* E-mail look (Administration → E-mail). */
  /** Background of the e-mail header (behind the logo). */
  emailHeaderColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).catch('#ffffff').default('#ffffff'),
  /** Buttons, links and highlights in e-mails. */
  emailAccentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).catch('#2563eb').default('#2563eb'),
  /** Extra line in the footer of every e-mail (address, legal text…). */
  emailFooter: z.string().max(1000).default(''),
  /** Set when the e-mail logo changes. */
  emailLogoUpdatedAt: z.string().nullable().default(null),
  /* Monthly client reports. */
  /** 'off', 'draft' (prepared for review) or 'publish' (published and e-mailed automatically). */
  reportsAutoMode: z.enum(['off', 'draft', 'publish']).default('draft'),
  /** Day of the month on which last month's reports are prepared (1–28). */
  reportsAutoDay: z.coerce.number().int().min(1).max(28).default(1),
});
export type SystemSettings = z.infer<typeof systemSettingsSchema>;

const KEY = 'system';

export async function getSystemSettings(db: Tx): Promise<SystemSettings> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY));
  return systemSettingsSchema.parse(row?.value ?? {});
}

export async function saveSystemSettings(db: Tx, patch: Partial<SystemSettings>): Promise<SystemSettings> {
  const merged = systemSettingsSchema.parse({ ...(await getSystemSettings(db)), ...patch });
  await db
    .insert(systemSettings)
    .values({ key: KEY, value: merged })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: merged } });
  return merged;
}

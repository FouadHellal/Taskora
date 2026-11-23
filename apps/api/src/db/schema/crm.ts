import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, customFields, id, money, slaPolicies, updatedAt, users } from './core.js';

export const companies = pgTable(
  'companies',
  {
    id: id(),
    name: text('name').notNull(),
    /** Optional user-facing unique account number / company ID. */
    accountNumber: text('account_number'),
    type: text('type').notNull().default('customer'),
    isActive: boolean('is_active').notNull().default(true),
    industry: text('industry'),
    website: text('website'),
    phone: text('phone'),
    email: text('email'),
    /** E-mail domains of the company (lesaures.com): incoming e-mail from them is matched to it. */
    emailDomains: text('email_domains').array().notNull().default(sql`'{}'::text[]`),
    address1: text('address1'),
    address2: text('address2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    parentCompanyId: integer('parent_company_id').references((): AnyPgColumn => companies.id, { onDelete: 'set null' }),
    primaryContactId: integer('primary_contact_id').references((): AnyPgColumn => contacts.id, { onDelete: 'set null' }),
    accountManagerId: integer('account_manager_id').references(() => users.id, { onDelete: 'set null' }),
    defaultSlaId: integer('default_sla_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    notes: text('notes'),
    customFields: customFields(),
    /** Set while the company has a logo (see `logos`); doubles as a cache-busting version. */
    logoUpdatedAt: timestamp('logo_updated_at', { withTimezone: true }),
    createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('companies_account_number_uq').on(t.accountNumber).where(sql`${t.accountNumber} is not null`),
    index('companies_name_idx').on(sql`lower(${t.name})`),
  ],
);

export const locations = pgTable(
  'locations',
  {
    id: id(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address1: text('address1'),
    address2: text('address2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    phone: text('phone'),
    isPrimary: boolean('is_primary').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('locations_company_idx').on(t.companyId)],
);

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    locationId: integer('location_id').references(() => locations.id, { onDelete: 'set null' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    title: text('title'),
    department: text('department'),
    email: text('email'),
    phone: text('phone'),
    mobile: text('mobile'),
    isActive: boolean('is_active').notNull().default(true),
    isPrimary: boolean('is_primary').notNull().default(false),
    notes: text('notes'),
    customFields: customFields(),
    /** Customer portal access (separate authentication realm from staff users). */
    portalEnabled: boolean('portal_enabled').notNull().default(false),
    portalPasswordHash: text('portal_password_hash'),
    portalLastLoginAt: timestamp('portal_last_login_at', { withTimezone: true }),
    portalResetTokenHash: text('portal_reset_token_hash'),
    portalResetExpiresAt: timestamp('portal_reset_expires_at', { withTimezone: true }),
    /** 'user' sees their own tickets; 'manager' sees every ticket, the work and the contracts of the company (primary contacts always do). */
    portalRole: text('portal_role').notNull().default('user'),
    /** Which e-mails the contact receives (ticketCreated, ticketReplies, ticketResolved, monthlyReport, companyTickets); missing keys use the defaults. */
    /** Second mailbox for ticket e-mails, and where they go: 'main', 'other' or 'both'. */
    notifyEmail: text('notify_email'),
    notifyMode: text('notify_mode').notNull().default('main'),
    emailPreferences: jsonb('email_preferences').$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('contacts_company_idx').on(t.companyId),
    index('contacts_email_idx').on(sql`lower(${t.email})`),
  ],
);

/** Customer portal sessions (hashed tokens), kept apart from staff sessions. */
export const portalSessions = pgTable('portal_sessions', {
  id: text('id').primaryKey(),
  contactId: integer('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  csrfToken: text('csrf_token').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Notes, calls, emails and meetings logged against a company (and optionally a contact). */
export const activities = pgTable(
  'activities',
  {
    id: id(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type').notNull().default('note'),
    subject: text('subject').notNull(),
    body: text('body'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('activities_company_idx').on(t.companyId, t.occurredAt)],
);

export const opportunities = pgTable(
  'opportunities',
  {
    id: id(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    stage: text('stage').notNull().default('qualification'),
    amount: money('amount'),
    probability: integer('probability').notNull().default(10),
    expectedCloseDate: date('expected_close_date', { mode: 'string' }),
    description: text('description'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('opportunities_company_idx').on(t.companyId)],
);

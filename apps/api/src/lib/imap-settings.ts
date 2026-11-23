import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Tx } from '../db/client.js';
import { systemSettings } from '../db/schema/index.js';
import { decryptJson, encryptJson } from './crypto.js';
import { resolveSmtp } from './mail.js';

/**
 * Inbound e-mail (IMAP) mailbox, configurable in the UI (Settings → E-mail to ticket).
 * Stored in `system_settings` under `imap` with the password encrypted with
 * TASKORA_ENCRYPTION_KEY; the IMAP_* environment variables remain a fallback.
 */
const KEY = 'imap';

const storedSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default(''),
  port: z.number().int().default(993),
  secure: z.boolean().default(true),
  user: z.string().default(''),
  passwordEncrypted: z.string().nullable().default(null),
  mailbox: z.string().default('INBOX'),
  /** Read the same mailbox that sends (Administration → E-mail): its user and password are reused. */
  useSmtpAccount: z.boolean().default(false),
});
type Stored = z.infer<typeof storedSchema>;

export const imapSettingsInputSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(255).default(''),
  /** Omitted keeps the stored password; empty string clears it. */
  password: z.string().max(1000).optional(),
  mailbox: z.string().trim().min(1).max(255).default('INBOX'),
  useSmtpAccount: z.boolean().default(false),
});

export interface ImapSettings {
  source: 'settings' | 'environment';
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
}

async function readStored(db: Tx): Promise<Stored> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY));
  return storedSchema.parse(row?.value ?? {});
}

/** IMAP server of a well-known SMTP host (smtp.gmail.com → imap.gmail.com). */
export function imapHostFor(smtpHost: string) {
  const h = smtpHost.trim().toLowerCase();
  if (h === 'smtp.gmail.com') return 'imap.gmail.com';
  if (h === 'smtp.office365.com' || h === 'smtp-mail.outlook.com') return 'outlook.office365.com';
  return h.replace(/^smtp\./, 'imap.');
}

/** The mailbox in effect (UI settings first, then environment) or null. */
export async function resolveImap(db: Tx, config: Config): Promise<ImapSettings | null> {
  const stored = await readStored(db);
  if (stored.enabled && stored.useSmtpAccount) {
    const smtp = await resolveSmtp(db, config);
    if (!smtp?.user || !smtp.password) return null;
    return {
      source: 'settings',
      host: stored.host || imapHostFor(smtp.host),
      port: stored.port || 993,
      secure: stored.secure,
      user: smtp.user,
      password: smtp.password,
      mailbox: stored.mailbox,
    };
  }
  if (stored.enabled && stored.host && stored.user) {
    let password = '';
    try {
      password = stored.passwordEncrypted ? decryptJson<string>(config.encryptionKey, stored.passwordEncrypted) : '';
    } catch {
      password = '';
    }
    return { source: 'settings', host: stored.host, port: stored.port, secure: stored.secure, user: stored.user, password, mailbox: stored.mailbox };
  }
  if (config.IMAP_HOST && config.IMAP_USER && config.IMAP_PASSWORD) {
    return {
      source: 'environment',
      host: config.IMAP_HOST,
      port: config.IMAP_PORT,
      secure: config.IMAP_SECURE,
      user: config.IMAP_USER,
      password: config.IMAP_PASSWORD,
      mailbox: config.IMAP_MAILBOX,
    };
  }
  return null;
}

/** Settings for the UI (never returns the password). */
export async function publicImapSettings(db: Tx, config: Config) {
  const stored = await readStored(db);
  const { passwordEncrypted, ...rest } = stored;
  return {
    ...rest,
    hasPassword: !!passwordEncrypted,
    environmentConfigured: !!(config.IMAP_HOST && config.IMAP_USER && config.IMAP_PASSWORD),
    environmentHost: config.IMAP_HOST ?? null,
  };
}

export async function saveImapSettings(db: Tx, config: Config, input: z.infer<typeof imapSettingsInputSchema>) {
  const current = await readStored(db);
  const passwordEncrypted =
    input.password === undefined ? current.passwordEncrypted : input.password === '' ? null : encryptJson(config.encryptionKey, input.password);
  const value: Stored = {
    enabled: input.enabled,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    passwordEncrypted,
    mailbox: input.mailbox,
    useSmtpAccount: input.useSmtpAccount,
  };
  await db.insert(systemSettings).values({ key: KEY, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}

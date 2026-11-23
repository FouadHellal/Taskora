import { eq } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Tx } from '../db/client.js';
import { systemSettings } from '../db/schema/index.js';
import { decryptJson, encryptJson } from './crypto.js';

/**
 * Outgoing e-mail (SMTP) settings. They can be configured in the UI (stored
 * in `system_settings` under the `smtp` key, password encrypted with
 * TASKORA_ENCRYPTION_KEY) and fall back to the SMTP_* environment variables.
 */

const KEY = 'smtp';

const storedSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default(''),
  port: z.number().int().default(587),
  secure: z.boolean().default(false),
  user: z.string().default(''),
  passwordEncrypted: z.string().nullable().default(null),
  from: z.string().default(''),
  replyTo: z.string().default(''),
  /** Appended to e-mails sent from tickets. */
  signature: z.string().default(''),
});
type Stored = z.infer<typeof storedSchema>;

export const mailSettingsInputSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(255).default(''),
  /** Omitted or undefined keeps the stored password; empty string clears it. */
  password: z.string().max(1000).optional(),
  from: z.string().trim().max(255),
  replyTo: z.string().trim().max(255).default(''),
  signature: z.string().max(20000).default(''),
});
export type MailSettingsInput = z.infer<typeof mailSettingsInputSchema>;

export interface SmtpSettings {
  source: 'settings' | 'environment';
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  replyTo: string;
  signature: string;
}

async function readStored(db: Tx): Promise<Stored> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, KEY));
  return storedSchema.parse(row?.value ?? {});
}

function envConfigured(config: Config) {
  return !!(config.SMTP_HOST && config.SMTP_FROM);
}

/** The SMTP settings in effect, or null when outgoing e-mail is not configured. */
export async function resolveSmtp(db: Tx, config: Config): Promise<SmtpSettings | null> {
  const stored = await readStored(db);
  if (stored.enabled && stored.host && stored.from) {
    let password = '';
    if (stored.passwordEncrypted) {
      try {
        password = decryptJson<string>(config.encryptionKey, stored.passwordEncrypted);
      } catch {
        password = '';
      }
    }
    return { source: 'settings', host: stored.host, port: stored.port, secure: stored.secure, user: stored.user, password, from: stored.from, replyTo: stored.replyTo, signature: stored.signature };
  }
  if (envConfigured(config)) {
    return {
      source: 'environment',
      host: config.SMTP_HOST!,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      user: config.SMTP_USER ?? '',
      password: config.SMTP_PASSWORD ?? '',
      from: config.SMTP_FROM!,
      replyTo: stored.replyTo,
      signature: stored.signature,
    };
  }
  return null;
}

export function transportFor(s: Pick<SmtpSettings, 'host' | 'port' | 'secure' | 'user' | 'password'>): Transporter {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
  });
}

/** Settings for the admin UI — never includes the password. */
export async function mailSettingsView(db: Tx, config: Config) {
  const stored = await readStored(db);
  const effective = await resolveSmtp(db, config);
  let passwordError: string | null = null;
  if (stored.passwordEncrypted) {
    try {
      decryptJson<string>(config.encryptionKey, stored.passwordEncrypted);
    } catch {
      passwordError = 'The stored SMTP password cannot be decrypted (TASKORA_ENCRYPTION_KEY changed?)';
    }
  }
  return {
    enabled: stored.enabled,
    host: stored.host,
    port: stored.port,
    secure: stored.secure,
    user: stored.user,
    hasPassword: !!stored.passwordEncrypted,
    passwordError,
    from: stored.from,
    replyTo: stored.replyTo,
    signature: stored.signature,
    environment: envConfigured(config) ? { host: config.SMTP_HOST!, port: config.SMTP_PORT, from: config.SMTP_FROM! } : null,
    effectiveSource: effective?.source ?? null,
  };
}

export async function saveMailSettings(db: Tx, config: Config, input: MailSettingsInput) {
  const stored = await readStored(db);
  const passwordEncrypted =
    input.password === undefined ? stored.passwordEncrypted : input.password === '' ? null : encryptJson(config.encryptionKey, input.password);
  const value: Stored = {
    enabled: input.enabled,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    passwordEncrypted,
    from: input.from,
    replyTo: input.replyTo,
    signature: input.signature,
  };
  await db
    .insert(systemSettings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}

const ADDRESS_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;

/** Splits "a@x.com, b@y.org; c@z.net" into validated addresses. */
export function parseAddresses(value: string | string[] | undefined): { valid: string[]; invalid: string[] } {
  const list = (Array.isArray(value) ? value : (value ?? '').split(/[,;\s]+/)).map((a) => a.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const a of list) (ADDRESS_RE.test(a) ? valid : invalid).push(a);
  return { valid: [...new Set(valid.map((a) => a.toLowerCase()))], invalid };
}

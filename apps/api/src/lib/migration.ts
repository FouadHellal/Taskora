import { randomBytes, scryptSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { createBackup, readBackup, type BackupDocument, type BackupSummary } from './backup.js';
import { decryptJson, encryptJson } from './crypto.js';
import { badRequest } from './errors.js';

/**
 * Migration packages: a full backup (every table + uploaded files) whose secrets are
 * portable. Normally integration secrets (SMTP/IMAP passwords, Action1 credentials, webhook
 * signing secrets) are encrypted with this server's TASKORA_ENCRYPTION_KEY, so a backup
 * restored on another server cannot use them. A migration package re-encrypts them with a
 * key derived from a passphrase chosen at export (scrypt + AES-256-GCM); on import they are
 * decrypted with the passphrase and re-encrypted with the new server's key.
 *
 * Everything else moves as-is: users keep their passwords (Argon2 hashes), API keys and
 * integration tokens keep working (SHA-256 hashes), settings, logos, custom fields,
 * workflows, webhooks, tickets, attachments… Sessions are not included: everyone signs in again.
 */

export interface MigrationInfo {
  kdf: 'scrypt';
  /** base64 salt for scrypt. */
  salt: string;
  /** "taskora" encrypted with the passphrase key: checks the passphrase before anything changes. */
  check: string;
  /** Secrets that could not be read on the source server (left empty). */
  skipped: string[];
  sourceOrganization: string | null;
  exportedAt: string;
}

/** Encrypted columns: [table, column]. */
const COLUMN_SECRETS: [string, string][] = [
  ['integrations', 'secrets_encrypted'],
  ['webhooks', 'secret_encrypted'],
];
/** system_settings keys whose JSON value holds `passwordEncrypted`. */
const SETTINGS_SECRETS = ['smtp', 'imap'];

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function passphraseKey(passphrase: string, salt: Buffer) {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
}

export function validatePassphrase(p: unknown): string {
  if (typeof p !== 'string' || p.length < 10) throw badRequest('Choose a passphrase of at least 10 characters', { fields: { passphrase: 'At least 10 characters' } });
  if (p.length > 512) throw badRequest('Passphrase too long');
  return p;
}

/** Re-encrypts every known secret from key `from` to key `to`; unreadable ones are cleared. */
function rekey(doc: BackupDocument, from: Buffer, to: Buffer, skipped: string[]) {
  const move = (value: unknown, label: string): string | null => {
    if (typeof value !== 'string' || !value) return null;
    try {
      return encryptJson(to, decryptJson<unknown>(from, value));
    } catch {
      skipped.push(label);
      return null;
    }
  };
  for (const [table, column] of COLUMN_SECRETS) {
    for (const row of doc.tables[table]?.rows ?? []) {
      if (row[column]) row[column] = move(row[column], `${table} #${String(row.id ?? row.provider ?? '?')}`);
    }
  }
  for (const row of doc.tables.system_settings?.rows ?? []) {
    if (!SETTINGS_SECRETS.includes(String(row.key))) continue;
    const value = row.value as Record<string, unknown> | null;
    if (value && typeof value === 'object' && value.passwordEncrypted) {
      value.passwordEncrypted = move(value.passwordEncrypted, `${String(row.key)} password`);
    }
  }
}

function organizationName(doc: BackupDocument): string | null {
  const row = doc.tables.system_settings?.rows.find((r) => r.key === 'system');
  const v = row?.value as { organizationName?: string } | undefined;
  return v?.organizationName ?? null;
}

/** Builds a gzip migration package protected by `passphrase`. */
export async function createMigrationPackage(db: Db, config: Config, passphrase: string): Promise<{ buffer: Buffer; summary: BackupSummary; skipped: string[] }> {
  const { buffer } = await createBackup(db, config, { includeFiles: true });
  const doc = readBackup(buffer);
  const salt = randomBytes(16);
  const key = passphraseKey(passphrase, salt);
  const skipped: string[] = [];
  rekey(doc, config.encryptionKey, key, skipped);
  doc.migration = {
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    check: encryptJson(key, 'taskora'),
    skipped,
    sourceOrganization: organizationName(doc),
    exportedAt: new Date().toISOString(),
  };
  const summary: BackupSummary = {
    tables: Object.keys(doc.tables).length,
    rows: Object.values(doc.tables).reduce((n, t) => n + (t.rows?.length ?? 0), 0),
    files: doc.files?.length ?? 0,
  };
  return { buffer: gzipSync(Buffer.from(JSON.stringify(doc), 'utf8')), summary, skipped };
}

/**
 * Opens a migration package with its passphrase and returns a backup document whose
 * secrets are encrypted with this server's key, ready for restoreBackup().
 */
export function openMigrationPackage(buffer: Buffer, config: Config, passphrase: string): { doc: BackupDocument; info: MigrationInfo; skipped: string[] } {
  const doc = readBackup(buffer);
  const info = doc.migration;
  if (!info) throw badRequest('This file is a normal backup, not a migration package. Use Restore instead (stored passwords will need to be re-entered).');
  if (info.kdf !== 'scrypt' || !info.salt || !info.check) throw badRequest('This migration package is damaged');
  const key = passphraseKey(passphrase, Buffer.from(info.salt, 'base64'));
  try {
    if (decryptJson<string>(key, info.check) !== 'taskora') throw new Error('mismatch');
  } catch {
    throw badRequest('Wrong passphrase for this migration package', { fields: { passphrase: 'Wrong passphrase' } });
  }
  const skipped = [...(info.skipped ?? [])];
  rekey(doc, key, config.encryptionKey, skipped);
  delete doc.migration;
  return { doc, info, skipped };
}

/** True when a backup buffer is a migration package (cheap check on the parsed header). */
export function isMigrationPackage(doc: BackupDocument) {
  return !!doc.migration;
}

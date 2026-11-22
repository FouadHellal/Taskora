import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import { badRequest } from './errors.js';
import type { MigrationInfo } from './migration.js';

/**
 * Full logical backups: every table of the `public` schema as JSON (produced
 * by PostgreSQL itself, so types round-trip exactly) plus, optionally, the
 * uploaded files. The result is one gzip file that can be kept on the server
 * (BACKUP_DIR) or downloaded, and restored through the API.
 */

export const BACKUP_FORMAT = 'taskora-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** Runtime state that is never backed up (and is cleared on restore). */
const EXCLUDED_TABLES = new Set(['sessions', 'jobs']);

const NAME_RE = /^taskora-(?:backup|migration)-[0-9]{8}-[0-9]{6}(?:-[a-z0-9-]{1,40})?\.json\.gz$/;
const INSERT_CHUNK = 500;

export interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: 'auto' | 'manual' | 'pre-restore' | 'migration';
}

export interface BackupSummary {
  tables: number;
  rows: number;
  files: number;
}

export interface BackupDocument {
  format: string;
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  schemaVersion: number;
  tables: Record<string, { rows: Record<string, unknown>[] }>;
  files?: { key: string; data: string }[];
  /** Present on migration packages: secrets are encrypted with a passphrase (lib/migration.ts). */
  migration?: MigrationInfo;
}

const ident = (name: string) => sql.raw(`"${name.replace(/"/g, '""')}"`);

async function rows<T>(db: Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await db.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}

async function publicTables(db: Tx): Promise<string[]> {
  const r = await rows<{ name: string }>(db, sql`select tablename as name from pg_tables where schemaname = 'public' order by tablename`);
  return r.map((t) => t.name);
}

async function schemaVersion(db: Tx): Promise<number> {
  try {
    const [r] = await rows<{ n: number }>(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Builds a gzip-compressed backup of the whole database (and uploads). */
export async function createBackup(db: Db, config: Config, opts: { includeFiles?: boolean } = {}): Promise<{ buffer: Buffer; summary: BackupSummary }> {
  const includeFiles = opts.includeFiles ?? true;
  // One read-only snapshot so the backup is consistent across tables.
  const { parts, summary } = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    const tables = (await publicTables(tx)).filter((t) => !EXCLUDED_TABLES.has(t));
    const parts: string[] = [];
    let total = 0;
    for (const t of tables) {
      const [r] = await rows<{ n: number; data: string }>(
        tx,
        sql`select count(*)::int as n, coalesce(json_agg(x), '[]'::json)::text as data from ${ident(t)} x`,
      );
      total += r?.n ?? 0;
      parts.push(`${JSON.stringify(t)}:{"rows":${r?.data ?? '[]'}}`);
    }
    return { parts, summary: { tables: tables.length, rows: total, files: 0 } as BackupSummary };
  });

  const header = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: process.env.TASKORA_VERSION ?? 'dev',
    createdAt: new Date().toISOString(),
    schemaVersion: await schemaVersion(db),
  };
  const files: string[] = [];
  if (includeFiles) {
    const root = resolve(config.UPLOAD_DIR);
    for (const path of await walk(root)) {
      const key = relative(root, path).split(sep).join('/');
      files.push(JSON.stringify({ key, data: (await readFile(path)).toString('base64') }));
    }
  }
  summary.files = files.length;
  const json = `${JSON.stringify(header).slice(0, -1)},"tables":{${parts.join(',')}},"files":[${files.join(',')}]}`;
  return { buffer: gzipSync(Buffer.from(json, 'utf8')), summary };
}

/** Parses and validates a backup file (gzip or plain JSON). */
export function readBackup(buffer: Buffer): BackupDocument {
  let doc: BackupDocument;
  try {
    const raw = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
    doc = JSON.parse(raw.toString('utf8')) as BackupDocument;
  } catch {
    throw badRequest('This file is not a readable Taskora backup');
  }
  if (doc?.format !== BACKUP_FORMAT || typeof doc.tables !== 'object' || !doc.tables) throw badRequest('This file is not a Taskora backup');
  if (doc.formatVersion > BACKUP_FORMAT_VERSION) throw badRequest('This backup was made by a newer version of Taskora; update Taskora first');
  return doc;
}

/**
 * Replaces ALL data with the content of a backup, atomically: either the
 * whole backup is restored or nothing changes. Foreign keys are dropped for
 * the duration of the load and re-created (and therefore re-validated)
 * before the transaction commits. Sessions and queued jobs are cleared, so
 * everybody signs in again afterwards.
 */
export async function restoreBackup(db: Db, config: Config, source: Buffer | BackupDocument): Promise<BackupSummary> {
  const doc = Buffer.isBuffer(source) ? readBackup(source) : source;
  if (doc.migration) {
    throw badRequest('This file is a migration package: import it with "Import migration package" and its passphrase so stored passwords keep working.');
  }
  const current = await schemaVersion(db);
  if (doc.schemaVersion > current) throw badRequest('This backup comes from a newer Taskora version (database schema); update Taskora first');

  const summary = await db.transaction(async (tx) => {
    const tables = await publicTables(tx);
    const known = new Set(tables);
    const unknown = Object.keys(doc.tables).filter((t) => !known.has(t) || EXCLUDED_TABLES.has(t));
    if (unknown.length) throw badRequest(`The backup contains unknown tables: ${unknown.slice(0, 5).join(', ')}`);

    const columns = await rows<{ table: string; column: string; generated: string; identity: string }>(
      tx,
      sql`select table_name as "table", column_name as "column", is_generated as generated, is_identity as identity
          from information_schema.columns where table_schema = 'public'`,
    );
    const fks = await rows<{ table: string; name: string; def: string }>(
      tx,
      sql`select cl.relname as "table", c.conname as name, pg_get_constraintdef(c.oid) as def
          from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_namespace n on n.oid = cl.relnamespace
          where c.contype = 'f' and n.nspname = 'public'`,
    );

    for (const fk of fks) await tx.execute(sql`alter table ${ident(fk.table)} drop constraint ${ident(fk.name)}`);
    await tx.execute(sql.raw(`truncate ${tables.map((t) => `"${t}"`).join(', ')} restart identity`));

    let total = 0;
    for (const [table, content] of Object.entries(doc.tables)) {
      const data = Array.isArray(content?.rows) ? content.rows : [];
      if (!data.length) continue;
      const cols = columns.filter((c) => c.table === table && c.generated !== 'ALWAYS');
      const present = new Set(data.flatMap((r) => Object.keys(r)));
      const use = cols.filter((c) => present.has(c.column)).map((c) => c.column);
      if (!use.length) continue;
      const list = sql.raw(use.map((c) => `"${c}"`).join(', '));
      const override = cols.some((c) => c.identity === 'YES' && use.includes(c.column)) ? sql.raw('overriding system value') : sql.raw('');
      for (let i = 0; i < data.length; i += INSERT_CHUNK) {
        const chunk = JSON.stringify(data.slice(i, i + INSERT_CHUNK));
        await tx.execute(
          sql`insert into ${ident(table)} (${list}) ${override} select ${list} from json_populate_recordset(null::${ident(table)}, ${chunk}::json)`,
        );
      }
      total += data.length;
    }

    for (const fk of fks) await tx.execute(sql.raw(`alter table "${fk.table}" add constraint "${fk.name}" ${fk.def}`));

    // Identity sequences continue after the restored ids.
    for (const c of columns.filter((x) => x.identity === 'YES')) {
      await tx.execute(
        sql`select setval(pg_get_serial_sequence(${`"${c.table}"`}, ${c.column}), coalesce((select max(${ident(c.column)}) from ${ident(c.table)}), 0) + 1, false)`,
      );
    }
    return { tables: Object.keys(doc.tables).length, rows: total, files: 0 };
  });

  if (doc.files?.length) {
    const root = resolve(config.UPLOAD_DIR);
    for (const f of doc.files) {
      const path = resolve(root, f.key);
      if (!path.startsWith(root + sep)) continue;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(f.data, 'base64'));
      summary.files++;
    }
  }
  return summary;
}

/* ---------------------------------------------------- server-side storage */

export function backupDir(config: Config) {
  return resolve(config.BACKUP_DIR);
}

export function isBackupName(name: string) {
  return NAME_RE.test(name);
}

function kindOf(name: string): BackupFile['kind'] {
  if (name.startsWith('taskora-migration-')) return 'migration';
  return name.includes('-auto') ? 'auto' : name.includes('-pre-restore') ? 'pre-restore' : 'manual';
}

export function backupFileName(kind: BackupFile['kind'], at = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
  if (kind === 'migration') return `taskora-migration-${stamp}.json.gz`;
  return `taskora-backup-${stamp}${kind === 'manual' ? '' : `-${kind}`}.json.gz`;
}

export async function listBackups(config: Config): Promise<BackupFile[]> {
  const dir = backupDir(config);
  if (!existsSync(dir)) return [];
  const out: BackupFile[] = [];
  for (const name of await readdir(dir)) {
    if (!isBackupName(name)) continue;
    const st = await stat(join(dir, name));
    out.push({ name, sizeBytes: st.size, createdAt: st.mtime.toISOString(), kind: kindOf(name) });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export function backupPath(config: Config, name: string) {
  if (!isBackupName(name)) throw badRequest('Invalid backup name');
  return join(backupDir(config), name);
}

/** Writes a new backup into BACKUP_DIR and returns its listing entry. */
export async function saveBackup(db: Db, config: Config, kind: BackupFile['kind'], opts: { includeFiles?: boolean } = {}) {
  const { buffer, summary } = await createBackup(db, config, opts);
  await mkdir(backupDir(config), { recursive: true });
  let name = backupFileName(kind);
  // Two backups in the same second: wait for the next stamp rather than overwrite.
  while (existsSync(join(backupDir(config), name))) {
    await new Promise((r) => setTimeout(r, 1000));
    name = backupFileName(kind);
  }
  await writeFile(join(backupDir(config), name), buffer, { flag: 'wx' });
  return { name, sizeBytes: buffer.length, createdAt: new Date().toISOString(), kind, summary };
}

/** Deletes the oldest automatic backups beyond `keep`. Manual backups are never pruned. */
export async function pruneAutoBackups(config: Config, keep: number) {
  const autos = (await listBackups(config)).filter((b) => b.kind === 'auto');
  const remove = autos.slice(keep);
  for (const b of remove) await unlink(join(backupDir(config), b.name)).catch(() => undefined);
  return remove.length;
}

/** True when the newest automatic backup is older than the interval. */
export async function autoBackupDue(config: Config, intervalHours: number, now = Date.now()) {
  const [last] = (await listBackups(config)).filter((b) => b.kind === 'auto');
  return !last || now - new Date(last.createdAt).getTime() >= intervalHours * 3600_000 - 60_000;
}

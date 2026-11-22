import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { backupDir, backupFileName, backupPath, createBackup, listBackups, readBackup, restoreBackup, saveBackup, type BackupDocument } from '../../lib/backup.js';
import { createMigrationPackage, openMigrationPackage, validatePassphrase } from '../../lib/migration.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentUser } from '../../lib/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getSystemSettings, saveSystemSettings } from '../../lib/settings.js';

const P = 'backups.manage' as const;

const createSchema = z.object({ includeFiles: z.boolean().default(true) });
const restoreSchema = z.object({
  /** Must be the literal word RESTORE — a guard against accidental clicks or scripted calls. */
  confirm: z.literal('RESTORE', { message: 'Type RESTORE to confirm' }),
  /** Save the current data as a "pre-restore" backup first (recommended). */
  safetyBackup: z.boolean().default(true),
});
const settingsSchema = z.object({
  autoBackupEnabled: z.boolean(),
  autoBackupIntervalHours: z.coerce.number().int().min(1).max(24 * 30),
  backupRetention: z.coerce.number().int().min(1).max(365),
});

function sendFile(reply: FastifyReply, name: string, buffer: Buffer) {
  return reply
    .header('content-type', 'application/gzip')
    .header('content-disposition', `attachment; filename="${name}"`)
    .header('cache-control', 'no-store')
    .send(buffer);
}

export async function backupRoutes(app: FastifyInstance) {
  app.get('/admin/backups', { config: { perm: P } }, async () => {
    const settings = await getSystemSettings(app.db);
    return {
      data: await listBackups(app.config),
      directory: backupDir(app.config),
      autoBackupEnabled: settings.autoBackupEnabled,
      autoBackupIntervalHours: settings.autoBackupIntervalHours,
      backupRetention: settings.backupRetention,
    };
  });

  app.put('/admin/backups/settings', { config: { perm: P } }, async (req) => {
    const input = settingsSchema.parse(req.body);
    const saved = await saveSystemSettings(app.db, input);
    await audit(app.db, req, { action: 'update', entityType: 'backup_settings', changes: input });
    return { autoBackupEnabled: saved.autoBackupEnabled, autoBackupIntervalHours: saved.autoBackupIntervalHours, backupRetention: saved.backupRetention };
  });

  /** Creates a backup and keeps it on the server. */
  app.post('/admin/backups', { config: { perm: P } }, async (req, reply) => {
    const input = createSchema.parse(req.body ?? {});
    const entry = await saveBackup(app.db, app.config, 'manual', input);
    await audit(app.db, req, { action: 'create', entityType: 'backup', entityId: entry.name, summary: `Backup ${entry.name}`, changes: { ...entry.summary } });
    return reply.status(201).send(entry);
  });

  /** Creates a backup and downloads it directly without keeping a copy on the server. */
  app.get('/admin/backups/export', { config: { perm: P } }, async (req, reply) => {
    const includeFiles = (req.query as { includeFiles?: string }).includeFiles !== 'false';
    const { buffer, summary } = await createBackup(app.db, app.config, { includeFiles });
    const name = backupFileName('manual');
    await audit(app.db, req, { action: 'export', entityType: 'backup', entityId: name, summary: `Backup downloaded (${name})`, changes: { ...summary } });
    return sendFile(reply, name, buffer);
  });

  app.get('/admin/backups/:name', { config: { perm: P } }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const path = backupPath(app.config, name);
    if (!existsSync(path)) throw notFound('Backup');
    await audit(app.db, req, { action: 'export', entityType: 'backup', entityId: name, summary: `Backup downloaded (${name})` });
    return sendFile(reply, name, await readFile(path));
  });

  app.delete('/admin/backups/:name', { config: { perm: P } }, async (req) => {
    const { name } = req.params as { name: string };
    const path = backupPath(app.config, name);
    if (!existsSync(path)) throw notFound('Backup');
    await unlink(path);
    await audit(app.db, req, { action: 'delete', entityType: 'backup', entityId: name, summary: `Backup ${name} deleted` });
    return { ok: true };
  });

  async function restore(input: Buffer | BackupDocument, source: string, safetyBackup: boolean, who: string, ip: string, extra: Record<string, unknown> = {}) {
    // Parse (and validate) before taking the safety backup, so a wrong file changes nothing.
    const doc = Buffer.isBuffer(input) ? readBackup(input) : input;
    if (doc.migration) {
      throw badRequest('This file is a migration package: use "Import migration package" with its passphrase so stored passwords keep working.');
    }
    const safety = safetyBackup ? await saveBackup(app.db, app.config, 'pre-restore') : null;
    const summary = await restoreBackup(app.db, app.config, doc);
    // The restored audit log replaces the old one, so record the restore afterwards.
    await audit(app.db, null, {
      action: 'restore',
      entityType: 'backup',
      entityId: source,
      summary: `Data restored from ${source} by ${who} (${ip})`,
      changes: { ...summary, safetyBackup: safety?.name ?? null, ...extra },
    });
    return { ok: true, ...summary, safetyBackup: safety?.name ?? null, ...extra };
  }

  /** Restores a backup stored on the server. Replaces ALL data and signs everybody out. */
  app.post('/admin/backups/:name/restore', { config: { perm: P } }, async (req) => {
    const { name } = req.params as { name: string };
    const input = restoreSchema.parse(req.body ?? {});
    const path = backupPath(app.config, name);
    if (!existsSync(path)) throw notFound('Backup');
    return restore(await readFile(path), name, input.safetyBackup, currentUser(req).email, req.ip);
  });

  /** Restores an uploaded backup file (multipart field "file"). `?confirm=RESTORE` is required. */
  app.post('/admin/backups/restore', { config: { perm: P } }, async (req) => {
    const q = req.query as { confirm?: string; safetyBackup?: string };
    const input = restoreSchema.parse({ confirm: q.confirm, safetyBackup: q.safetyBackup !== 'false' });
    if (!req.isMultipart()) throw badRequest('Upload the backup file as multipart/form-data');
    const part = await req.file({ limits: { fileSize: app.config.MAX_RESTORE_MB * 1024 * 1024, files: 1 } });
    if (!part) throw badRequest('No backup file uploaded');
    const buffer = await part.toBuffer();
    if (part.file.truncated) throw badRequest(`The backup exceeds the ${app.config.MAX_RESTORE_MB} MB limit (MAX_RESTORE_MB)`);
    return restore(buffer, part.filename || 'upload', input.safetyBackup, currentUser(req).email, req.ip);
  });

  /* ------------------------------------------------ move to another server */

  const exportSchema = z.object({ passphrase: z.string(), save: z.boolean().default(false) });
  const importSchema = z.object({ passphrase: z.string(), confirm: z.literal('RESTORE', { message: 'Type RESTORE to confirm' }), safetyBackup: z.boolean().default(true) });

  /**
   * Migration package: everything (data, settings, users, API keys, webhooks, files) with stored
   * passwords re-encrypted by a passphrase, to import on another Taskora server.
   * `save: true` keeps it in the backups folder; otherwise it is downloaded.
   */
  app.post('/admin/migration/export', { config: { perm: P } }, async (req, reply) => {
    const input = exportSchema.parse(req.body ?? {});
    const passphrase = validatePassphrase(input.passphrase);
    const { buffer, summary, skipped } = await createMigrationPackage(app.db, app.config, passphrase);
    const name = backupFileName('migration');
    await audit(app.db, req, { action: 'export', entityType: 'migration', entityId: name, summary: `Migration package ${input.save ? 'saved' : 'downloaded'} (${name})`, changes: { ...summary, skipped } });
    if (input.save) {
      await mkdir(backupDir(app.config), { recursive: true });
      await writeFile(join(backupDir(app.config), name), buffer, { flag: 'wx' });
      return reply.status(201).send({ name, sizeBytes: buffer.length, kind: 'migration', summary, skipped });
    }
    reply.header('x-taskora-skipped-secrets', String(skipped.length));
    return sendFile(reply, name, buffer);
  });

  async function importPackage(buffer: Buffer, source: string, passphrase: string, safetyBackup: boolean, who: string, ip: string) {
    const { doc, info, skipped } = openMigrationPackage(buffer, app.config, passphrase);
    return restore(doc, source, safetyBackup, who, ip, { migratedFrom: info.sourceOrganization, exportedAt: info.exportedAt, skippedSecrets: skipped });
  }

  /** Imports an uploaded migration package (multipart: field "passphrase" BEFORE field "file"). `?confirm=RESTORE` required. */
  app.post('/admin/migration/import', { config: { perm: P } }, async (req) => {
    const q = req.query as { confirm?: string; safetyBackup?: string };
    if (!req.isMultipart()) throw badRequest('Upload the migration package as multipart/form-data');
    const part = await req.file({ limits: { fileSize: app.config.MAX_RESTORE_MB * 1024 * 1024, files: 1 } });
    if (!part) throw badRequest('No file uploaded');
    const field = (part.fields as Record<string, { value?: unknown } | undefined>).passphrase;
    const input = importSchema.parse({ passphrase: field?.value ?? '', confirm: q.confirm, safetyBackup: q.safetyBackup !== 'false' });
    const buffer = await part.toBuffer();
    if (part.file.truncated) throw badRequest(`The file exceeds the ${app.config.MAX_RESTORE_MB} MB upload limit (MAX_RESTORE_MB). Copy it to the server and import it from the list instead.`);
    return importPackage(buffer, part.filename || 'upload', input.passphrase, input.safetyBackup, currentUser(req).email, req.ip);
  });

  /** Imports a migration package already in the server's backups folder. */
  app.post('/admin/migration/import/:name', { config: { perm: P } }, async (req) => {
    const { name } = req.params as { name: string };
    const input = importSchema.parse(req.body ?? {});
    const path = backupPath(app.config, name);
    if (!existsSync(path)) throw notFound('File');
    return importPackage(await readFile(path), name, input.passphrase, input.safetyBackup, currentUser(req).email, req.ip);
  });
}

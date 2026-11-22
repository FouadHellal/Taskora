/**
 * Move a whole Taskora installation to another server (same as Settings → Move to another server).
 *
 *   node dist/cli/migration.js export            writes /app/data/backups/taskora-migration-<time>.json.gz
 *   node dist/cli/migration.js import <file> --yes
 *
 * The passphrase comes from TASKORA_MIGRATION_PASSPHRASE (at least 10 characters); the same
 * passphrase is needed to import. Import REPLACES all data on this server (a pre-restore backup
 * is saved first) and signs everybody out. <file> may be a name in the backups folder or a path.
 *
 * Docker: docker compose exec -e TASKORA_MIGRATION_PASSPHRASE='…' api node dist/cli/migration.js export
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { backupDir, backupFileName, restoreBackup, saveBackup } from '../lib/backup.js';
import { createMigrationPackage, openMigrationPackage, validatePassphrase } from '../lib/migration.js';

function usage(): never {
  console.error('Usage:');
  console.error('  node dist/cli/migration.js export');
  console.error('  node dist/cli/migration.js import <file> --yes');
  console.error('Set TASKORA_MIGRATION_PASSPHRASE (at least 10 characters).');
  process.exit(2);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const [command, file] = args;
  if (!command || args.includes('-h') || args.includes('--help')) usage();
  let passphrase: string;
  try {
    passphrase = validatePassphrase(process.env.TASKORA_MIGRATION_PASSPHRASE);
  } catch {
    console.error('TASKORA_MIGRATION_PASSPHRASE must be set to at least 10 characters.');
    return 2;
  }
  const config = loadConfig();
  const { db, pool } = createDb(config.DATABASE_URL, 2);
  try {
    if (command === 'export') {
      const { buffer, summary, skipped } = await createMigrationPackage(db, config, passphrase);
      const name = backupFileName('migration');
      await mkdir(backupDir(config), { recursive: true });
      const path = join(backupDir(config), name);
      await writeFile(path, buffer, { flag: 'wx' });
      await audit(db, null, { action: 'export', entityType: 'migration', entityId: name, summary: `Migration package written by the CLI (${name})`, changes: { ...summary, skipped } });
      console.log(`Migration package written: ${path}`);
      console.log(`${summary.tables} tables, ${summary.rows} rows, ${summary.files} files, ${(buffer.length / 1048576).toFixed(1)} MB`);
      if (skipped.length) console.log(`Warning: ${skipped.length} stored secret(s) could not be read and will be empty: ${skipped.join(', ')}`);
      return 0;
    }
    if (command === 'import') {
      if (!file) usage();
      if (!args.includes('--yes')) {
        console.error('Import replaces ALL data on this server. Add --yes to confirm.');
        return 2;
      }
      const path = isAbsolute(file) || file.includes('/') ? file : join(backupDir(config), file);
      if (!existsSync(path)) {
        console.error(`File not found: ${path}`);
        return 1;
      }
      const { doc, info, skipped } = openMigrationPackage(await readFile(path), config, passphrase);
      const safety = await saveBackup(db, config, 'pre-restore');
      console.log(`Current data saved first: ${safety.name}`);
      const summary = await restoreBackup(db, config, doc);
      await audit(db, null, {
        action: 'restore',
        entityType: 'migration',
        entityId: file,
        summary: `Migration package imported by the CLI from ${info.sourceOrganization ?? 'another server'}`,
        changes: { ...summary, safetyBackup: safety.name, skippedSecrets: skipped },
      });
      console.log(`Imported ${summary.tables} tables, ${summary.rows} rows and ${summary.files} files from "${info.sourceOrganization ?? 'another server'}" (exported ${info.exportedAt}).`);
      if (skipped.length) console.log(`Re-enter these secrets in Settings: ${skipped.join(', ')}`);
      console.log('Everyone has been signed out; sign in with the accounts from the old server.');
      return 0;
    }
    usage();
  } catch (e) {
    console.error(`Failed: ${(e as Error).message}`);
    return 1;
  } finally {
    await pool.end();
  }
}

main().then((code) => process.exit(code));

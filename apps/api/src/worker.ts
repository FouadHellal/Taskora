/**
 * Background worker: runs scheduled maintenance (SLA monitoring, time-based
 * workflow rules, Action1 synchronisation) and processes queued jobs.
 * Several workers can run concurrently; jobs are claimed with SKIP LOCKED.
 */
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, lte, sql } from 'drizzle-orm';
import pino from 'pino';
import { loadConfig, type Config } from './config.js';
import { createDb, runMigrations, waitForDatabase, type Db } from './db/client.js';
import { integrations } from './db/schema/index.js';
import { claimJob, completeJob, enqueue, failJob, recoverStaleJobs, type JobRow } from './jobs/queue.js';
import { runSlaMonitor } from './jobs/sla-monitor.js';
import { runStatusAgeRules } from './modules/automation/engine.js';
import { runRecurringTickets } from './modules/tickets/recurring.js';
import { runBusinessReminders } from './jobs/reminders.js';
import { runAction1Sync } from './integrations/action1/sync.js';
import { dispatchNotificationEmails, expireStaleEmails, sendCustomerNote } from './jobs/email.js';
import { resolveSmtp } from './lib/mail.js';
import { autoBackupDue, pruneAutoBackups, saveBackup } from './lib/backup.js';
import { getSystemSettings } from './lib/settings.js';
import { pollInbox } from './jobs/inbound-email.js';
import { resolveImap } from './lib/imap-settings.js';
import { deliverWebhook } from './lib/webhooks.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { svc: 'worker' } });
const workerId = `${hostname()}:${process.pid}`;
const HEARTBEAT_FILE = join(tmpdir(), 'taskora-worker-heartbeat');

type Handler = (db: Db, config: Config, job: JobRow) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  'sla.check': (db) => runSlaMonitor(db),
  'tickets.recurring': (db) => runRecurringTickets(db),
  'reminders.daily': (db) => runBusinessReminders(db),
  'workflow.status_age': (db) => runStatusAgeRules(db),
  'action1.sync': (db, cfg, job) =>
    runAction1Sync(db, cfg, {
      trigger: (job.payload.trigger as 'manual' | 'scheduled') ?? 'scheduled',
      userId: (job.payload.userId as number | null) ?? null,
    }),
  'email.dispatch': (db, cfg) => dispatchNotificationEmails(db, cfg),
  'email.customer_note': (db, cfg, job) => sendCustomerNote(db, cfg, Number(job.payload.noteId)),
  'email.inbound': (db, cfg) => pollInbox(db, cfg, (m) => log.info({ job: 'email.inbound' }, m)),
  'webhook.deliver': (db, cfg, job) => deliverWebhook(db, cfg, job.payload),
  'backup.auto': async (db, cfg) => {
    const settings = await getSystemSettings(db);
    const saved = await saveBackup(db, cfg, 'auto');
    const pruned = await pruneAutoBackups(cfg, settings.backupRetention);
    return { name: saved.name, sizeBytes: saved.sizeBytes, pruned };
  },
  'maintenance.cleanup': async (db) => {
    await expireStaleEmails(db);
    await db.execute(sql`delete from sessions where expires_at < now()`);
    await db.execute(sql`delete from notifications where read_at is not null and read_at < now() - interval '90 days'`);
    await db.execute(sql`delete from jobs where status in ('done','failed') and coalesce(finished_at, created_at) < now() - interval '14 days'`);
    await db.execute(sql`delete from workflow_executions where executed_at < now() - interval '180 days'`);
  },
};

/** Enqueues periodic jobs; dedupe keys prevent piling up when a run is slow. */
async function schedule(db: Db) {
  await enqueue(db, 'sla.check', {}, { dedupeKey: 'sla.check', maxAttempts: 1 });
  await enqueue(db, 'workflow.status_age', {}, { dedupeKey: 'workflow.status_age', maxAttempts: 1 });
  await enqueue(db, 'tickets.recurring', {}, { dedupeKey: 'tickets.recurring', maxAttempts: 1 });
  if (await resolveSmtp(db, config)) await enqueue(db, 'email.dispatch', {}, { dedupeKey: 'email.dispatch', maxAttempts: 1 });
  const settings = await getSystemSettings(db);
  if (settings.autoBackupEnabled && (await autoBackupDue(config, settings.autoBackupIntervalHours))) {
    await enqueue(db, 'backup.auto', {}, { dedupeKey: 'backup.auto', maxAttempts: 2 });
  }
  if (await resolveImap(db, config)) await enqueue(db, 'email.inbound', {}, { dedupeKey: 'email.inbound', maxAttempts: 1 });
  const [a1] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.provider, 'action1'), eq(integrations.enabled, true), lte(integrations.nextSyncAt, new Date())));
  if (a1) await enqueue(db, 'action1.sync', { trigger: 'scheduled' }, { dedupeKey: 'action1.sync', maxAttempts: 3 });
}

async function main() {
  const { db, pool } = createDb(config.DATABASE_URL, Math.min(config.DATABASE_POOL_MAX, 5));
  await waitForDatabase(pool, 120_000, (m) => log.warn(m));
  await runMigrations(db);
  log.info({ workerId }, 'worker started');

  // Liveness for the container healthcheck: the file's mtime stays fresh while
  // the event loop runs (docker-compose.yml checks it is younger than 90 s).
  const heartbeat = () => {
    try {
      writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'cannot write heartbeat file');
    }
  };
  heartbeat();
  setInterval(heartbeat, 15_000).unref();

  let stopping = false;
  let lastSchedule = 0;
  let lastCleanup = 0;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info('worker stopping');
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      const now = Date.now();
      if (now - lastSchedule >= 60_000) {
        lastSchedule = now;
        await recoverStaleJobs(db);
        await schedule(db);
      }
      if (now - lastCleanup >= 24 * 3600_000) {
        lastCleanup = now;
        await enqueue(db, 'maintenance.cleanup', {}, { dedupeKey: 'maintenance.cleanup', maxAttempts: 1 });
        await enqueue(db, 'reminders.daily', {}, { dedupeKey: 'reminders.daily', maxAttempts: 1 });
      }
      const job = await claimJob(db, workerId);
      if (!job) {
        await new Promise((r) => setTimeout(r, config.WORKER_POLL_MS));
        continue;
      }
      const handler = handlers[job.type];
      const started = Date.now();
      try {
        if (!handler) throw new Error(`No handler for job type ${job.type}`);
        const result = await handler(db, config, job);
        await completeJob(db, job.id);
        log.info({ job: job.type, id: job.id, ms: Date.now() - started, result: summarise(result) }, 'job done');
      } catch (err) {
        await failJob(db, job, err);
        log.warn({ job: job.type, id: job.id, attempt: job.attempts, err: (err as Error).message }, 'job failed');
      }
    } catch (err) {
      log.error({ err }, 'worker loop error');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await pool.end();
}

function summarise(result: unknown) {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  return 'stats' in r ? { status: r.status, stats: r.stats } : r;
}

main().catch((err) => {
  log.fatal({ err }, 'worker crashed');
  process.exit(1);
});

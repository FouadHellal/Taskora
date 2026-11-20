import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { join, resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { Tx } from '../db/client.js';
import { audit } from './audit.js';
import { AppError, badRequest, forbidden, notFound } from './errors.js';

/**
 * Super-admin "force delete": removes a record together with everything that still
 * references it, instead of failing with "this record is referenced by other records".
 *
 * The reference graph is read from the database's own foreign keys (pg_constraint), so it
 * covers every table without a hand-maintained list:
 *  - a NOT NULL reference means the child cannot exist without the parent → the child is
 *    deleted too (recursively, children first);
 *  - a nullable reference is cleared (set to NULL), except the few "owned" links listed in
 *    OWNED_NULLABLE, which are deleted with their parent;
 *  - in "reassign" mode (picklists such as statuses or queues) every reference is moved to
 *    `replaceWith` instead, so no ticket is lost.
 * Polymorphic rows (attachments, logos) are removed for deleted records, and attachment files
 * are unlinked after the transaction commits. Everything runs in one transaction.
 */

export interface ForceDeleteRoute {
  /** Database table name (e.g. 'companies'). */
  table: string;
  /** Route parameter holding the id (default 'id'). */
  param?: string;
  /** Offer "move references to another record" instead of cascading (picklists). */
  reassign?: boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    forceDelete?: ForceDeleteRoute;
  }
}

interface Fk {
  childTable: string;
  childColumn: string;
  nullable: boolean;
}

/** Tables that are never deleted as a side effect (history and access must survive). */
const PROTECTED = new Set(['users', 'roles', 'system_settings', 'sequences']);
/** Nullable links whose child belongs to the parent and should go with it. */
const OWNED_NULLABLE = new Set(['time_entries.ticket_id', 'time_entries.project_task_id', 'expenses.ticket_id', 'service_calls.ticket_id', 'ticket_checklist_items.ticket_id']);
/** Tables whose rows can own attachments / logos (attachments.entity_type values). */
const ENTITY_TYPES: Record<string, string> = {
  tickets: 'ticket',
  companies: 'company',
  configuration_items: 'configuration_item',
  kb_articles: 'kb_article',
  contracts: 'contract',
  projects: 'project',
};
/** Friendly labels for the preview. */
const LABELS: Record<string, string> = {
  tickets: 'Tickets',
  ticket_notes: 'Ticket notes',
  ticket_events: 'Ticket history events',
  time_entries: 'Time entries',
  contacts: 'Contacts',
  locations: 'Locations',
  configuration_items: 'Configuration items',
  contracts: 'Contracts',
  projects: 'Projects',
  invoices: 'Invoices',
  invoice_lines: 'Invoice lines',
  expenses: 'Expenses',
  attachments: 'Attachments',
  opportunities: 'Opportunities',
  activities: 'Activities',
  service_calls: 'Service calls',
};

const CHUNK = 5000;

async function rows<T>(db: Tx, q: SQL): Promise<T[]> {
  const res = (await db.execute(q)) as unknown as { rows: T[] };
  return res.rows;
}

const ident = (name: string) => sql.identifier(name);
const inList = (ids: unknown[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

function chunks<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
  return out;
}

export class ForceDeleter {
  private fkCache = new Map<string, Fk[]>();
  private idColCache = new Map<string, boolean>();
  private nameColCache = new Map<string, string | null>();
  /** Rows (by table) deleted or to be deleted. */
  readonly deleted = new Map<string, Set<string>>();
  /** Count of references cleared/moved, by "table.column". */
  readonly cleared = new Map<string, number>();
  readonly files: string[] = [];

  constructor(
    private db: Tx,
    private dryRun: boolean,
    private replaceWith: number | null = null,
  ) {}

  private async fks(table: string): Promise<Fk[]> {
    let fks = this.fkCache.get(table);
    if (!fks) {
      fks = await rows<Fk>(
        this.db,
        sql`select cl.relname as "childTable", att.attname as "childColumn", not att.attnotnull as "nullable"
            from pg_constraint con
            join pg_class cl on cl.oid = con.conrelid
            join pg_class pcl on pcl.oid = con.confrelid
            join pg_namespace ns on ns.oid = pcl.relnamespace
            join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
            where con.contype = 'f' and ns.nspname = 'public' and pcl.relname = ${table} and array_length(con.conkey, 1) = 1
            order by cl.relname, att.attname`,
      );
      this.fkCache.set(table, fks);
    }
    return fks;
  }

  private async hasIdColumn(table: string): Promise<boolean> {
    if (!this.idColCache.has(table)) {
      const r = await rows<{ n: number }>(
        this.db,
        sql`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = 'id'`,
      );
      this.idColCache.set(table, (r[0]?.n ?? 0) > 0);
    }
    return this.idColCache.get(table)!;
  }

  async nameColumn(table: string): Promise<string | null> {
    if (!this.nameColCache.has(table)) {
      const r = await rows<{ c: string }>(
        this.db,
        sql`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = ${table}
            and column_name in ('name', 'title', 'label', 'ticket_number', 'code', 'email') order by array_position(array['name','title','label','ticket_number','code','email'], column_name::text) limit 1`,
      );
      this.nameColCache.set(table, r[0]?.c ?? null);
    }
    return this.nameColCache.get(table)!;
  }

  private mark(table: string, ids: unknown[]): unknown[] {
    let set = this.deleted.get(table);
    if (!set) this.deleted.set(table, (set = new Set()));
    const fresh = ids.filter((i) => !set!.has(String(i)));
    for (const i of fresh) set.add(String(i));
    return fresh;
  }

  /** Deletes `ids` of `table` and everything depending on them (children first). */
  async remove(table: string, ids: unknown[], root = false): Promise<void> {
    if (!ids.length) return;
    if (PROTECTED.has(table)) {
      throw new AppError(
        409,
        'protected',
        `Deleting this would also delete ${ids.length} record(s) in "${table}", which Taskora never deletes automatically. Remove or reassign them first.`,
      );
    }
    const fresh = this.mark(table, ids);
    if (!fresh.length) return;

    for (const fk of await this.fks(table)) {
      const key = `${fk.childTable}.${fk.childColumn}`;
      for (const part of chunks(fresh)) {
        if (root && this.replaceWith !== null) {
          // Reassign mode: move every reference of the deleted picklist value to the replacement.
          const [{ n }] = (await rows<{ n: number }>(
            this.db,
            sql`select count(*)::int as n from ${ident(fk.childTable)} where ${ident(fk.childColumn)} in (${inList(part)})`,
          )) as [{ n: number }];
          if (n && !this.dryRun) {
            await this.db.execute(sql`update ${ident(fk.childTable)} set ${ident(fk.childColumn)} = ${this.replaceWith} where ${ident(fk.childColumn)} in (${inList(part)})`);
          }
          if (n) this.cleared.set(key, (this.cleared.get(key) ?? 0) + n);
          continue;
        }
        const cascade = !fk.nullable || OWNED_NULLABLE.has(key);
        if (cascade) {
          if (await this.hasIdColumn(fk.childTable)) {
            const childIds = (await rows<{ id: unknown }>(this.db, sql`select id from ${ident(fk.childTable)} where ${ident(fk.childColumn)} in (${inList(part)})`)).map((r) => r.id);
            await this.remove(fk.childTable, childIds);
          } else {
            // Join tables without an id (watchers, relations…): delete the rows directly.
            const [{ n }] = (await rows<{ n: number }>(
              this.db,
              sql`select count(*)::int as n from ${ident(fk.childTable)} where ${ident(fk.childColumn)} in (${inList(part)})`,
            )) as [{ n: number }];
            if (n) {
              const set = this.deleted.get(fk.childTable) ?? new Set<string>();
              for (let i = 0; i < n; i++) set.add(`${key}:${part.join(',')}:${i}`);
              this.deleted.set(fk.childTable, set);
              if (!this.dryRun) await this.db.execute(sql`delete from ${ident(fk.childTable)} where ${ident(fk.childColumn)} in (${inList(part)})`);
            }
          }
        } else {
          const [{ n }] = (await rows<{ n: number }>(
            this.db,
            sql`select count(*)::int as n from ${ident(fk.childTable)} where ${ident(fk.childColumn)} in (${inList(part)})`,
          )) as [{ n: number }];
          if (n) {
            this.cleared.set(key, (this.cleared.get(key) ?? 0) + n);
            if (!this.dryRun) await this.db.execute(sql`update ${ident(fk.childTable)} set ${ident(fk.childColumn)} = null where ${ident(fk.childColumn)} in (${inList(part)})`);
          }
        }
      }
    }

    const entityType = ENTITY_TYPES[table];
    for (const part of chunks(fresh)) {
      if (entityType) {
        const files = await rows<{ id: number; storage_key: string }>(
          this.db,
          sql`select id, storage_key from attachments where entity_type = ${entityType} and entity_id in (${inList(part)})`,
        );
        if (files.length) {
          this.mark('attachments', files.map((f) => f.id));
          this.files.push(...files.map((f) => f.storage_key));
          if (!this.dryRun) await this.db.execute(sql`delete from attachments where entity_type = ${entityType} and entity_id in (${inList(part)})`);
        }
        if (!this.dryRun) await this.db.execute(sql`delete from logos where entity_type = ${entityType} and entity_id in (${inList(part)})`);
      }
      if (!this.dryRun) await this.db.execute(sql`delete from ${ident(table)} where id in (${inList(part)})`);
    }
  }

  summary(rootTable: string) {
    const removed = [...this.deleted.entries()]
      .map(([table, set]) => ({ table, label: LABELS[table] ?? humanize(table), count: table === rootTable ? set.size - 1 : set.size }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);
    const cleared = [...this.cleared.entries()].map(([key, count]) => {
      const [table, column] = key.split('.') as [string, string];
      return { table, column, label: `${LABELS[table] ?? humanize(table)} → ${humanize(column.replace(/_id$/, ''))}`, count };
    });
    return { removed, cleared, files: this.files.length };
  }
}

function humanize(s: string) {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function isSuperAdmin(req: FastifyRequest) {
  return !!req.user?.permissions.includes('*');
}

/**
 * Global hook: any DELETE route declaring `config.forceDelete` accepts
 *   ?force=preview  → what would be removed (no change)
 *   ?force=true[&replaceWith=<id>] → removes it all in one transaction
 * for super administrators (role with every permission) only.
 */
export function registerForceDelete(app: FastifyInstance) {
  const uploadRoot = resolve(app.config.UPLOAD_DIR);
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'DELETE') return;
    const cfg = req.routeOptions.config?.forceDelete;
    const q = req.query as { force?: string; replaceWith?: string };
    if (!cfg || !q.force) return;
    if (!isSuperAdmin(req)) throw forbidden('Only a super administrator (a role with every permission) can force-delete records');
    const raw = (req.params as Record<string, string>)[cfg.param ?? 'id'];
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid id');
    const replaceWith = q.replaceWith ? Number(q.replaceWith) : null;
    if (replaceWith !== null && (!cfg.reassign || !Number.isInteger(replaceWith) || replaceWith === id)) throw badRequest('Invalid replacement');

    const run = async (tx: Tx, dryRun: boolean) => {
      const d = new ForceDeleter(tx, dryRun, replaceWith);
      const nameCol = await d.nameColumn(cfg.table);
      const [row] = await rows<{ id: number; name: string | null }>(
        tx,
        sql`select id, ${nameCol ? sql`${ident(nameCol)}::text` : sql`null`} as name from ${ident(cfg.table)} where id = ${id}`,
      );
      if (!row) throw notFound();
      if (replaceWith !== null) {
        const [target] = await rows<{ id: number }>(tx, sql`select id from ${ident(cfg.table)} where id = ${replaceWith}`);
        if (!target) throw badRequest('The replacement record does not exist');
      }
      await d.remove(cfg.table, [id], true);
      let options: { id: number; name: string }[] | undefined;
      if (dryRun && cfg.reassign && nameCol) {
        options = await rows<{ id: number; name: string }>(
          tx,
          sql`select id, ${ident(nameCol)}::text as name from ${ident(cfg.table)} where id <> ${id} order by 2 limit 500`,
        );
      }
      return { name: row.name ?? `#${id}`, d, options };
    };

    if (q.force === 'preview') {
      const { name, d, options } = await app.db.transaction(async (tx) => {
        const r = await run(tx, true);
        // Never commit anything from a preview.
        return r;
      });
      return reply.send({ table: cfg.table, id, name, reassign: !!cfg.reassign, options, ...d.summary(cfg.table) });
    }
    if (q.force !== 'true') throw badRequest('force must be "preview" or "true"');

    const { name, d } = await app.db.transaction(async (tx) => {
      const r = await run(tx, false);
      const sum = r.d.summary(cfg.table);
      await audit(tx, req, {
        action: 'delete',
        entityType: cfg.table,
        entityId: id,
        summary: `Force-deleted ${r.name ?? id}`,
        changes: { forced: true, replaceWith, removed: sum.removed, cleared: sum.cleared } as never,
      });
      return r;
    });
    for (const key of d.files) {
      const path = join(uploadRoot, key);
      if (path.startsWith(uploadRoot)) await unlink(path).catch(() => undefined);
    }
    return reply.send({ ok: true, forced: true, name, ...d.summary(cfg.table) });
  });
}

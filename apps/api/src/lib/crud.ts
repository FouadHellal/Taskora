import type { FastifyInstance } from 'fastify';
import { asc, eq, getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgTable, PgColumn } from 'drizzle-orm/pg-core';
import type { ZodType } from 'zod';
import type { Permission } from '@taskora/shared';
import { notFound } from './errors.js';
import { audit, diff } from './audit.js';
import type { Tx } from '../db/client.js';

interface CrudOptions<T extends PgTable> {
  path: string;
  table: T;
  entityType: string;
  schema: ZodType<Record<string, unknown>>;
  /** Omit to allow any signed-in user (picklists). */
  readPerm?: Permission | Permission[];
  writePerm: Permission;
  orderBy?: SQL[];
  /** Columns allowed as equality filters via query string (e.g. ?issueTypeId=3). */
  filters?: Record<string, PgColumn>;
  /** Called inside the write transaction; may enforce invariants (e.g. single default). */
  beforeWrite?: (tx: Tx, data: Record<string, unknown>, id: number | null) => Promise<void>;
  afterWrite?: (tx: Tx, row: Record<string, unknown>, input: Record<string, unknown>) => Promise<void>;
  /** Decorates rows returned by list/get. */
  expand?: (db: Tx, rows: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
}

/**
 * Registers list/get/create/update/delete routes for small configuration
 * tables (statuses, queues, work types…). Lists are unpaginated by design:
 * these tables are short and used to populate pickers.
 */
export function registerCrud<T extends PgTable>(app: FastifyInstance, o: CrudOptions<T>) {
  const cols = getTableColumns(o.table) as Record<string, PgColumn>;
  const idCol = cols.id!;
  const tableAny = o.table as any;
  const stripUnknown = (data: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(data).filter(([k]) => k in cols && k !== 'id'));

  app.get(o.path, { config: { perm: o.readPerm } }, async (req) => {
    const q = req.query as Record<string, string>;
    const conds: SQL[] = [];
    for (const [key, col] of Object.entries(o.filters ?? {})) {
      if (q[key] !== undefined && q[key] !== '') conds.push(eq(col, q[key] === 'true' ? true : q[key] === 'false' ? false : q[key]));
    }
    if (q.active === 'true' && cols.isActive) conds.push(eq(cols.isActive, true));
    let query = app.db.select().from(tableAny).$dynamic();
    if (conds.length) query = query.where(sql.join(conds, sql` and `));
    const rows = (await query.orderBy(...(o.orderBy ?? (cols.sortOrder ? [asc(cols.sortOrder), asc(idCol)] : [asc(idCol)])))) as Record<
      string,
      unknown
    >[];
    return { data: o.expand ? await o.expand(app.db, rows) : rows };
  });

  app.get(`${o.path}/:id`, { config: { perm: o.readPerm } }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const [row] = (await app.db.select().from(tableAny).where(eq(idCol, id))) as Record<string, unknown>[];
    if (!row) throw notFound();
    return o.expand ? (await o.expand(app.db, [row]))[0] : row;
  });

  app.post(o.path, { config: { perm: o.writePerm } }, async (req, reply) => {
    const input = o.schema.parse(req.body);
    const row = await app.db.transaction(async (tx) => {
      const data = stripUnknown(input);
      await o.beforeWrite?.(tx, data, null);
      const [created] = (await tx.insert(tableAny).values(data).returning()) as Record<string, unknown>[];
      await o.afterWrite?.(tx, created!, input);
      await audit(tx, req, { action: 'create', entityType: o.entityType, entityId: created!.id as number, summary: String(created!.name ?? '') });
      return created!;
    });
    return reply.status(201).send(row);
  });

  app.patch(`${o.path}/:id`, { config: { perm: o.writePerm } }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const partial = (o.schema as any).partial ? (o.schema as any).partial() : o.schema;
    const input = partial.parse(req.body) as Record<string, unknown>;
    return app.db.transaction(async (tx) => {
      const [before] = (await tx.select().from(tableAny).where(eq(idCol, id))) as Record<string, unknown>[];
      if (!before) throw notFound();
      const data = stripUnknown(Object.fromEntries(Object.entries(input).filter(([k]) => k in (req.body as object))));
      await o.beforeWrite?.(tx, data, id);
      const [updated] = Object.keys(data).length
        ? ((await tx.update(tableAny).set(data).where(eq(idCol, id)).returning()) as Record<string, unknown>[])
        : [before];
      await o.afterWrite?.(tx, updated!, input);
      await audit(tx, req, { action: 'update', entityType: o.entityType, entityId: id, changes: diff(before, data) });
      return updated;
    });
  });

  app.delete(`${o.path}/:id`, { config: { perm: o.writePerm, forceDelete: { table: getTableName(o.table), reassign: true } } }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    await app.db.transaction(async (tx) => {
      const [row] = (await tx.delete(tableAny).where(eq(idCol, id)).returning()) as Record<string, unknown>[];
      if (!row) throw notFound();
      await audit(tx, req, { action: 'delete', entityType: o.entityType, entityId: id, summary: String(row.name ?? '') });
    });
    return { ok: true };
  });
}

/** Ensures at most one row of `table` has is_default = true. */
export function singleDefault(table: PgTable) {
  const cols = getTableColumns(table) as Record<string, PgColumn>;
  return async (tx: Tx, data: Record<string, unknown>) => {
    if (data.isDefault === true) await tx.update(table as any).set({ isDefault: false }).where(eq(cols.isDefault!, true));
  };
}

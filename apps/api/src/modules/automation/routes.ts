import type { FastifyInstance } from 'fastify';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { workflowRuleSchema, type WorkflowCondition } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { countAll, intParam, paginated, parseList, whereAll } from '../../lib/query.js';
import { currentUser } from '../../lib/context.js';
import { getTicketRow } from '../tickets/service.js';
import { matchesConditions } from './engine.js';

export async function automationRoutes(app: FastifyInstance) {
  const P = 'automation.manage' as const;

  app.get('/workflow-rules', { config: { perm: P } }, async () => {
    const rows = await app.db.select().from(s.workflowRules).orderBy(asc(s.workflowRules.sortOrder), asc(s.workflowRules.id));
    return { data: rows };
  });

  app.get('/workflow-rules/:id', { config: { perm: P } }, async (req) => {
    const [row] = await app.db.select().from(s.workflowRules).where(eq(s.workflowRules.id, idOf(req)));
    if (!row) throw notFound('Workflow rule');
    return row;
  });

  app.post('/workflow-rules', { config: { perm: P } }, async (req, reply) => {
    const input = workflowRuleSchema.parse(req.body);
    const [row] = await app.db.insert(s.workflowRules).values({ ...input, createdById: currentUser(req).id }).returning();
    await audit(app.db, req, { action: 'create', entityType: 'workflow_rule', entityId: row!.id, summary: row!.name });
    return reply.status(201).send(row);
  });

  app.put('/workflow-rules/:id', { config: { perm: P } }, async (req) => {
    const id = idOf(req);
    const input = workflowRuleSchema.parse(req.body);
    const [before] = await app.db.select().from(s.workflowRules).where(eq(s.workflowRules.id, id));
    if (!before) throw notFound('Workflow rule');
    const [row] = await app.db.update(s.workflowRules).set(input).where(eq(s.workflowRules.id, id)).returning();
    await audit(app.db, req, { action: 'update', entityType: 'workflow_rule', entityId: id, summary: row!.name, changes: diff(before, input) });
    return row;
  });

  app.patch('/workflow-rules/:id/active', { config: { perm: P } }, async (req) => {
    const isActive = !!(req.body as { isActive?: boolean }).isActive;
    const [row] = await app.db.update(s.workflowRules).set({ isActive }).where(eq(s.workflowRules.id, idOf(req))).returning();
    if (!row) throw notFound('Workflow rule');
    await audit(app.db, req, { action: 'update', entityType: 'workflow_rule', entityId: row.id, summary: `${isActive ? 'Enabled' : 'Disabled'} ${row.name}` });
    return row;
  });

  app.delete('/workflow-rules/:id', { config: { perm: P, forceDelete: { table: 'workflow_rules' } } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.delete(s.workflowRules).where(eq(s.workflowRules.id, id)).returning();
    if (!row) throw notFound('Workflow rule');
    await audit(app.db, req, { action: 'delete', entityType: 'workflow_rule', entityId: id, summary: row.name });
    return { ok: true };
  });

  /** Dry run: does the rule's condition set match a given ticket right now? */
  app.post('/workflow-rules/test', { config: { perm: P } }, async (req) => {
    const body = req.body as { ticketId?: number; conditions?: WorkflowCondition[] };
    const ticket = await getTicketRow(app.db, Number(body.ticketId));
    const conditions = workflowRuleSchema.shape.conditions.parse(body.conditions ?? []);
    return { matches: matchesConditions(ticket as unknown as Record<string, unknown>, conditions) };
  });

  app.get('/workflow-executions', { config: { perm: P } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(
      intParam(q.ruleId) ? eq(s.workflowExecutions.ruleId, intParam(q.ruleId)!) : undefined,
      intParam(q.ticketId) ? eq(s.workflowExecutions.ticketId, intParam(q.ticketId)!) : undefined,
      q.status ? eq(s.workflowExecutions.status, String(q.status)) : undefined,
    );
    const rows = await app.db
      .select({
        execution: s.workflowExecutions,
        ruleName: s.workflowRules.name,
        ticketNumber: s.tickets.ticketNumber,
      })
      .from(s.workflowExecutions)
      .innerJoin(s.workflowRules, eq(s.workflowRules.id, s.workflowExecutions.ruleId))
      .leftJoin(s.tickets, eq(s.tickets.id, s.workflowExecutions.ticketId))
      .where(where)
      .orderBy(desc(s.workflowExecutions.executedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.workflowExecutions).where(where)) as [{ n: number }];
    return paginated(rows.map((r) => ({ ...r.execution, ruleName: r.ruleName, ticketNumber: r.ticketNumber })), n, q);
  });

  app.get('/workflow-rules/stats', { config: { perm: P } }, async () => {
    const rows = await app.db.execute(sql`
      select rule_id as "ruleId", count(*) filter (where status = 'success')::int as success, count(*) filter (where status = 'failed')::int as failed
      from workflow_executions where executed_at > now() - interval '30 days' group by rule_id`);
    return { data: rows.rows };
  });
}

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { formatNumber, kbArticleSchema } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit, diff } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { countAll, intParam, likeTerm, nextSequence, paginated, parseList, whereAll } from '../../lib/query.js';
import { currentUser } from '../../lib/context.js';
import { getSystemSettings } from '../../lib/settings.js';

export async function kbRoutes(app: FastifyInstance) {
  app.get('/kb/articles', { config: { perm: 'kb.read' } }, async (req) => {
    const q = parseList(req.query);
    const scope = String(q.scope ?? 'all'); // 'kb' = general, 'docs' = company documentation
    const term = q.q ? likeTerm(String(q.q)) : null;
    const where = whereAll(
      scope === 'kb' ? isNull(s.kbArticles.companyId) : undefined,
      scope === 'docs' ? sql`${s.kbArticles.companyId} is not null` : undefined,
      intParam(q.companyId) ? eq(s.kbArticles.companyId, intParam(q.companyId)!) : undefined,
      intParam(q.categoryId) ? eq(s.kbArticles.categoryId, intParam(q.categoryId)!) : undefined,
      q.status ? inArray(s.kbArticles.status, String(q.status).split(',')) : undefined,
      q.visibility ? eq(s.kbArticles.visibility, String(q.visibility)) : undefined,
      q.tag ? sql`${String(q.tag)} = any(${s.kbArticles.tags})` : undefined,
      term
        ? or(
            sql`${s.kbArticles.title} ilike ${term}`,
            sql`${s.kbArticles.body} ilike ${term}`,
            sql`${s.kbArticles.articleNumber} ilike ${term}`,
            sql`array_to_string(${s.kbArticles.tags}, ' ') ilike ${term}`,
          )
        : undefined,
    );
    // Title matches rank above body matches.
    const rank = term ? [sql`(case when ${s.kbArticles.title} ilike ${term} then 0 else 1 end)`] : [];
    const rows = await app.db
      .select({
        id: s.kbArticles.id,
        articleNumber: s.kbArticles.articleNumber,
        title: s.kbArticles.title,
        excerpt: sql<string>`left(regexp_replace(${s.kbArticles.body}, '[#*_>\`\\[\\]]', '', 'g'), 220)`,
        categoryId: s.kbArticles.categoryId,
        categoryName: s.kbCategories.name,
        companyId: s.kbArticles.companyId,
        companyName: s.companies.name,
        tags: s.kbArticles.tags,
        visibility: s.kbArticles.visibility,
        status: s.kbArticles.status,
        views: s.kbArticles.views,
        authorName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        portalAuthorName: sql<string | null>`(select c.first_name || ' ' || c.last_name from contacts c where c.id = ${s.kbArticles.portalAuthorContactId})`,
        updatedAt: s.kbArticles.updatedAt,
      })
      .from(s.kbArticles)
      .leftJoin(s.kbCategories, eq(s.kbCategories.id, s.kbArticles.categoryId))
      .leftJoin(s.companies, eq(s.companies.id, s.kbArticles.companyId))
      .leftJoin(s.users, eq(s.users.id, s.kbArticles.authorId))
      .where(where)
      .orderBy(...rank, desc(s.kbArticles.updatedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.kbArticles).where(where)) as [{ n: number }];
    return paginated(rows, n, q);
  });

  app.get('/kb/articles/:id', { config: { perm: 'kb.read' } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db
      .select({
        article: s.kbArticles,
        categoryName: s.kbCategories.name,
        companyName: s.companies.name,
        authorName: sql<string | null>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
      })
      .from(s.kbArticles)
      .leftJoin(s.kbCategories, eq(s.kbCategories.id, s.kbArticles.categoryId))
      .leftJoin(s.companies, eq(s.companies.id, s.kbArticles.companyId))
      .leftJoin(s.users, eq(s.users.id, s.kbArticles.authorId))
      .where(eq(s.kbArticles.id, id));
    if (!row) throw notFound('Article');
    if ((req.query as { view?: string }).view === 'true') {
      await app.db.update(s.kbArticles).set({ views: sql`${s.kbArticles.views} + 1`, updatedAt: row.article.updatedAt }).where(eq(s.kbArticles.id, id));
    }
    const tickets = await app.db
      .select({ id: s.tickets.id, ticketNumber: s.tickets.ticketNumber, title: s.tickets.title })
      .from(s.kbArticleTickets)
      .innerJoin(s.tickets, eq(s.tickets.id, s.kbArticleTickets.ticketId))
      .where(eq(s.kbArticleTickets.articleId, id));
    return { ...row.article, categoryName: row.categoryName, companyName: row.companyName, authorName: row.authorName, tickets };
  });

  app.post('/kb/articles', { config: { perm: 'kb.write' } }, async (req, reply) => {
    const input = kbArticleSchema.parse(req.body);
    const me = currentUser(req);
    const row = await app.db.transaction(async (tx) => {
      const settings = await getSystemSettings(tx);
      const [r] = await tx
        .insert(s.kbArticles)
        .values({
          ...input,
          articleNumber: formatNumber(settings.kbPrefix, await nextSequence(tx, 'kb')),
          authorId: me.id,
          updatedById: me.id,
          publishedAt: input.status === 'published' ? new Date() : null,
        })
        .returning();
      await audit(tx, req, { action: 'create', entityType: 'kb_article', entityId: r!.id, summary: r!.title });
      return r!;
    });
    return reply.status(201).send(row);
  });

  app.patch('/kb/articles/:id', { config: { perm: 'kb.write' } }, async (req) => {
    const id = idOf(req);
    const input = kbArticleSchema.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    const [before] = await app.db.select().from(s.kbArticles).where(eq(s.kbArticles.id, id));
    if (!before) throw notFound('Article');
    const data = Object.fromEntries(Object.entries(input).filter(([k]) => k in body)) as Partial<typeof before>;
    data.updatedById = currentUser(req).id;
    if (data.status === 'published' && !before.publishedAt) data.publishedAt = new Date();
    const [row] = await app.db.update(s.kbArticles).set(data).where(eq(s.kbArticles.id, id)).returning();
    await audit(app.db, req, { action: 'update', entityType: 'kb_article', entityId: id, summary: row!.title, changes: diff(before, { ...data, body: undefined }) });
    return row;
  });

  app.delete('/kb/articles/:id', { config: { perm: 'kb.write', forceDelete: { table: 'kb_articles' } } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.delete(s.kbArticles).where(eq(s.kbArticles.id, id)).returning();
    if (!row) throw notFound('Article');
    await audit(app.db, req, { action: 'delete', entityType: 'kb_article', entityId: id, summary: row.title });
    return { ok: true };
  });

  /** Link an article to a ticket (shown on both sides). */
  app.post('/kb/articles/:id/tickets', { config: { perm: 'tickets.write' } }, async (req, reply) => {
    const ticketId = Number((req.body as { ticketId?: number }).ticketId);
    await app.db.insert(s.kbArticleTickets).values({ articleId: idOf(req), ticketId }).onConflictDoNothing();
    return reply.status(201).send({ ok: true });
  });
  app.delete('/kb/articles/:id/tickets/:ticketId', { config: { perm: 'tickets.write' } }, async (req) => {
    await app.db
      .delete(s.kbArticleTickets)
      .where(and(eq(s.kbArticleTickets.articleId, idOf(req)), eq(s.kbArticleTickets.ticketId, idOf(req, 'ticketId'))));
    return { ok: true };
  });
  app.get('/tickets/:id/kb', { config: { perm: 'kb.read' } }, async (req) => {
    const rows = await app.db
      .select({ id: s.kbArticles.id, articleNumber: s.kbArticles.articleNumber, title: s.kbArticles.title, visibility: s.kbArticles.visibility })
      .from(s.kbArticleTickets)
      .innerJoin(s.kbArticles, eq(s.kbArticles.id, s.kbArticleTickets.articleId))
      .where(eq(s.kbArticleTickets.ticketId, idOf(req)));
    return { data: rows };
  });
}

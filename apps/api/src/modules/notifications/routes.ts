import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import * as s from '../../db/schema/index.js';
import { idOf } from '../../lib/params.js';
import { countAll, paginated, parseList, whereAll } from '../../lib/query.js';
import { currentUser } from '../../lib/context.js';
import { resolveSmtp } from '../../lib/mail.js';
import { resolveImap } from '../../lib/imap-settings.js';

export async function notificationRoutes(app: FastifyInstance) {
  /** Inbound e-mail processing log (administrators). */
  app.get('/inbound-emails', { config: { perm: 'settings.manage' } }, async (req) => {
    const q = parseList(req.query);
    const rows = await app.db
      .select()
      .from(s.inboundEmails)
      .orderBy(desc(s.inboundEmails.receivedAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.inboundEmails)) as [{ n: number }];
    return { ...paginated(rows, n, q), imapConfigured: !!(await resolveImap(app.db, app.config)), smtpConfigured: !!(await resolveSmtp(app.db, app.config)) };
  });

  app.get('/notifications', async (req) => {
    const me = currentUser(req);
    const q = parseList(req.query);
    const where = whereAll(eq(s.notifications.userId, me.id), q.unread === 'true' ? isNull(s.notifications.readAt) : undefined);
    const rows = await app.db
      .select()
      .from(s.notifications)
      .where(where)
      .orderBy(desc(s.notifications.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.notifications).where(where)) as [{ n: number }];
    const [{ unread }] = (await app.db
      .select({ unread: countAll })
      .from(s.notifications)
      .where(and(eq(s.notifications.userId, me.id), isNull(s.notifications.readAt)))) as [{ unread: number }];
    return { ...paginated(rows, n, q), unread };
  });

  app.get('/notifications/unread-count', async (req) => {
    const [{ unread }] = (await app.db
      .select({ unread: countAll })
      .from(s.notifications)
      .where(and(eq(s.notifications.userId, currentUser(req).id), isNull(s.notifications.readAt)))) as [{ unread: number }];
    return { unread };
  });

  app.post('/notifications/:id/read', async (req) => {
    await app.db
      .update(s.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(s.notifications.id, idOf(req)), eq(s.notifications.userId, currentUser(req).id)));
    return { ok: true };
  });

  app.post('/notifications/read-all', async (req) => {
    await app.db
      .update(s.notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(s.notifications.userId, currentUser(req).id), isNull(s.notifications.readAt)));
    return { ok: true };
  });
}

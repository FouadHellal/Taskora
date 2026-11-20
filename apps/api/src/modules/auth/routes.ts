import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { changePasswordSchema, loginSchema, setupSchema } from '@taskora/shared';
import { roles, sessions, users } from '../../db/schema/index.js';
import { hashPassword, randomToken, safeEqual, verifyPassword } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { resolveSmtp } from '../../lib/mail.js';
import { audit } from '../../lib/audit.js';
import { currentUser } from '../../lib/context.js';
import { getSystemSettings, saveSystemSettings } from '../../lib/settings.js';
import { createSession, destroySession } from './session.js';

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;
// Pre-computed hash used to equalise timing when the e-mail is unknown.
let dummyHash: string | null = null;

async function userCount(app: FastifyInstance): Promise<number> {
  const [row] = await app.db.select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
}

let generatedSetupToken: string | null = null;

/** Logs the one-time setup token while the instance has no users. */
export async function announceSetupToken(app: FastifyInstance) {
  if ((await userCount(app)) > 0) return;
  if (app.config.TASKORA_SETUP_TOKEN) {
    app.log.warn('Taskora has no administrator yet. Open the web UI and use TASKORA_SETUP_TOKEN to complete setup.');
    return;
  }
  generatedSetupToken ??= randomToken(18);
  app.log.warn(`Taskora has no administrator yet. Initial setup token: ${generatedSetupToken}`);
}

function expectedSetupToken(app: FastifyInstance): string | null {
  return app.config.TASKORA_SETUP_TOKEN ?? generatedSetupToken;
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/setup/status', { config: { public: true } }, async () => {
    const settings = await getSystemSettings(app.db);
    return { needsSetup: (await userCount(app)) === 0, organizationName: settings.organizationName, logoUpdatedAt: settings.logoUpdatedAt };
  });

  app.post(
    '/setup',
    { config: { public: true, rateLimit: { max: app.config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = setupSchema.parse(req.body);
      if ((await userCount(app)) > 0) throw conflict('Setup has already been completed');
      const expected = expectedSetupToken(app);
      if (!expected || !safeEqual(input.setupToken, expected)) {
        throw new AppError(403, 'invalid_setup_token', 'Invalid setup token. Check the API logs for the current token.');
      }
      const [adminRole] = await app.db.select().from(roles).where(eq(roles.key, 'administrator'));
      if (!adminRole) throw new AppError(500, 'not_seeded', 'Base data missing — run migrations first');
      const [user] = await app.db
        .insert(users)
        .values({
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          passwordHash: await hashPassword(input.password),
          roleId: adminRole.id,
          timezone: input.timezone,
          title: 'Administrator',
        })
        .returning();
      await saveSystemSettings(app.db, { organizationName: input.organizationName, timezone: input.timezone });
      generatedSetupToken = null;
      await audit(app.db, req, { action: 'create', entityType: 'user', entityId: user!.id, summary: 'Initial administrator created' }, user!.id);
      const { csrfToken } = await createSession(app, req, reply, user!.id);
      return { ok: true, csrfToken };
    },
  );

  app.post(
    '/auth/login',
    { config: { public: true, rateLimit: { max: app.config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = loginSchema.parse(req.body);
      const [user] = await app.db.select().from(users).where(sql`lower(${users.email}) = ${input.email}`);
      if (!user) {
        dummyHash ??= await hashPassword(randomToken());
        await verifyPassword(dummyHash, input.password);
        await audit(app.db, req, { action: 'login_failed', entityType: 'auth', summary: 'Unknown account' });
        throw unauthorized('Invalid e-mail or password');
      }
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        throw new AppError(423, 'locked', 'Too many failed attempts. Try again later.');
      }
      const ok = await verifyPassword(user.passwordHash, input.password);
      if (!ok || !user.isActive) {
        const failed = user.failedLogins + 1;
        await app.db
          .update(users)
          .set({
            failedLogins: failed >= MAX_FAILED ? 0 : failed,
            lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
          })
          .where(eq(users.id, user.id));
        await audit(app.db, req, { action: 'login_failed', entityType: 'user', entityId: user.id }, user.id);
        throw unauthorized('Invalid e-mail or password');
      }
      await app.db
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id));
      const { csrfToken } = await createSession(app, req, reply, user.id);
      await audit(app.db, req, { action: 'login', entityType: 'user', entityId: user.id }, user.id);
      return { ok: true, csrfToken };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    await audit(app.db, req, { action: 'logout', entityType: 'user', entityId: req.user?.id });
    await destroySession(app, req, reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const user = currentUser(req);
    const settings = await getSystemSettings(app.db);
    const [prefs] = await app.db.select({ preferences: users.preferences }).from(users).where(eq(users.id, user.id));
    return {
      user,
      preferences: prefs?.preferences ?? {},
      emailEnabled: !!(await resolveSmtp(app.db, app.config)),
      csrfToken: req.csrfToken,
      organization: {
        name: settings.organizationName,
        currency: settings.currency,
        timezone: settings.timezone,
        logoUpdatedAt: settings.logoUpdatedAt,
        language: settings.language,
        dateFormat: settings.dateFormat,
        ticketsOpenInWindow: settings.ticketsOpenInWindow,
      },
      superAdmin: user.permissions.includes('*'),
    };
  });

  app.post('/auth/change-password', async (req) => {
    const me = currentUser(req);
    const input = changePasswordSchema.parse(req.body);
    const [user] = await app.db.select().from(users).where(eq(users.id, me.id));
    if (!user || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw badRequest('Current password is incorrect');
    }
    await app.db.update(users).set({ passwordHash: await hashPassword(input.newPassword) }).where(eq(users.id, me.id));
    // Invalidate all other sessions.
    await app.db.delete(sessions).where(sql`${sessions.userId} = ${me.id} and ${sessions.id} <> ${req.sessionId}`);
    await audit(app.db, req, { action: 'update', entityType: 'user', entityId: me.id, summary: 'Password changed' });
    return { ok: true };
  });

  /** The signed-in user's active sessions (devices). */
  app.get('/auth/sessions', async (req) => {
    const me = currentUser(req);
    const rows = await app.db
      .select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt, ip: sessions.ip, userAgent: sessions.userAgent })
      .from(sessions)
      .where(sql`${sessions.userId} = ${me.id} and ${sessions.expiresAt} > now()`)
      .orderBy(sql`${sessions.lastSeenAt} desc`);
    return { data: rows.map((r) => ({ ...r, id: r.id.slice(0, 16), current: r.id === req.sessionId })) };
  });

  /** Signs out one session (by id prefix) or, with `all`, every other session. */
  app.delete('/auth/sessions/:id', async (req) => {
    const me = currentUser(req);
    const { id } = req.params as { id: string };
    if (id === 'others') {
      await app.db.delete(sessions).where(sql`${sessions.userId} = ${me.id} and ${sessions.id} <> ${req.sessionId}`);
    } else {
      if (!/^[0-9a-f]{16}$/.test(id)) throw badRequest('Invalid session id');
      await app.db.delete(sessions).where(sql`${sessions.userId} = ${me.id} and left(${sessions.id}, 16) = ${id} and ${sessions.id} <> ${req.sessionId}`);
    }
    await audit(app.db, req, { action: 'logout', entityType: 'user', entityId: me.id, summary: id === 'others' ? 'Signed out other sessions' : 'Signed out a session' });
    return { ok: true };
  });

  app.patch('/auth/preferences', async (req) => {
    const me = currentUser(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed: Record<string, unknown> = {};
    for (const key of ['theme', 'sidebarCollapsed', 'ticketColumns', 'defaultTicketView', 'emailNotifications', 'language', 'ticketOpenMode', 'ticketTab']) {
      if (key in body) allowed[key] = body[key];
    }
    if (typeof body.timezone === 'string' && body.timezone.length < 64) {
      await app.db.update(users).set({ timezone: body.timezone }).where(eq(users.id, me.id));
    }
    await app.db
      .update(users)
      .set({ preferences: sql`${users.preferences} || ${JSON.stringify(allowed)}::jsonb` })
      .where(eq(users.id, me.id));
    return { ok: true };
  });
}

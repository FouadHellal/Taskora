import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, lt } from 'drizzle-orm';
import { hasPermission, type Permission } from '@taskora/shared';
import { integrationTokens, roles, sessions, users } from '../../db/schema/index.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import type { AuthUser } from '../../lib/context.js';
import type { Db } from '../../db/client.js';

export const SESSION_COOKIE = 'taskora_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function createSession(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, userId: number) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + app.config.SESSION_TTL_HOURS * 3600_000);
  await app.db.insert(sessions).values({
    id: sha256(token),
    userId,
    csrfToken,
    expiresAt,
    ip: req.ip,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 255),
  });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(app, req),
    expires: expiresAt,
  });
  return { csrfToken, expiresAt };
}

function cookieSecure(app: FastifyInstance, req: FastifyRequest): boolean {
  if (app.config.COOKIE_SECURE === 'true') return true;
  if (app.config.COOKIE_SECURE === 'false') return false;
  return req.protocol === 'https';
}

export async function destroySession(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
  if (req.sessionId) await app.db.delete(sessions).where(eq(sessions.id, req.sessionId));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

const TOKEN_RE = /^Bearer (tki_[A-Za-z0-9_-]{32,128})$/;

/**
 * Integration token check (docs/integrations/atlas.md): hashed lookup, not revoked or expired,
 * and the route's scope granted. Same error for every failure so tokens cannot be probed.
 */
export async function authenticateIntegration(db: Db, req: FastifyRequest, scope: string | string[]) {
  const m = TOKEN_RE.exec(String(req.headers.authorization ?? ''));
  if (!m) throw unauthorized('Integration token required');
  const [row] = await db.select().from(integrationTokens).where(eq(integrationTokens.tokenHash, sha256(m[1]!)));
  const now = new Date();
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) throw unauthorized('Invalid integration token');
  if (!([] as string[]).concat(scope).some((x) => row.scopes.includes(x))) {
    throw forbidden('This integration token does not have the required scope');
  }
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(integrationTokens).set({ lastUsedAt: now, lastUsedIp: req.ip }).where(eq(integrationTokens.id, row.id));
  }
  return { tokenId: row.id, name: row.name, scopes: row.scopes };
}

export async function loadAuthUser(db: Db, userId: number): Promise<AuthUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      roleId: users.roleId,
      roleKey: roles.key,
      roleName: roles.name,
      permissions: roles.permissions,
      timezone: users.timezone,
      isTechnician: users.isTechnician,
      isActive: users.isActive,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId));
  if (!row || !row.isActive) return null;
  const { isActive: _ignored, ...user } = row;
  return user;
}

/**
 * Global authentication/authorization hook. Every /api route requires a valid
 * session unless marked `config.public`, and the route's `config.perm` is
 * enforced here so handlers cannot forget it.
 */
export function registerAuthHook(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('csrfToken', null);
  app.decorateRequest('integration', null);

  let lastCleanup = 0;

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const cfg = req.routeOptions.config ?? {};

    if (cfg.scope) {
      req.integration = await authenticateIntegration(app.db, req, cfg.scope);
      return;
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const sid = sha256(token);
      const [session] = await app.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sid), gt(sessions.expiresAt, new Date())));
      if (session) {
        const user = await loadAuthUser(app.db, session.userId);
        if (user) {
          req.user = user;
          req.sessionId = sid;
          req.csrfToken = session.csrfToken;
          // Sliding expiry, refreshed at most every 5 minutes.
          if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
            await app.db
              .update(sessions)
              .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + app.config.SESSION_TTL_HOURS * 3600_000) })
              .where(eq(sessions.id, sid));
          }
        }
      }
    }

    if (Date.now() - lastCleanup > 3600_000) {
      lastCleanup = Date.now();
      await app.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    }

    if (cfg.public) return;
    if (!req.user) throw unauthorized();

    // CSRF: cookie-authenticated state-changing requests must echo the session's token.
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || header !== req.csrfToken) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }

    if (cfg.perm) {
      const required = (Array.isArray(cfg.perm) ? cfg.perm : [cfg.perm]) as Permission[];
      if (!required.some((p) => hasPermission(req.user!.permissions, p))) throw forbidden();
    }
  });
}

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import type { Transporter } from 'nodemailer';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { errorHandler } from './lib/errors.js';
import { registerAuthHook } from './modules/auth/session.js';
import { authRoutes } from './modules/auth/routes.js';
import { registerModules } from './modules/index.js';
import { portalRoutes } from './modules/portal/routes.js';

export interface BuildOptions {
  db: Db;
  config: Config;
  logger?: boolean | object;
  /** Overrides outgoing SMTP (tests). */
  mailTransport?: Transporter;
}

export async function buildApp({ db, config, logger, mailTransport }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      logger ??
      (config.NODE_ENV === 'development'
        ? { level: config.LOG_LEVEL, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : { level: config.LOG_LEVEL }),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('mailTransport', mailTransport ?? null);

  // Route catalogue (method, path, permission) used to generate docs/api.md.
  const routeCatalog: { method: string; url: string; perm: string | null; public: boolean; scope?: string }[] = [];
  app.decorate('routeCatalog', routeCatalog);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const cfg = (route.config ?? {}) as { perm?: string | string[]; public?: boolean; scope?: string | string[] };
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routeCatalog.push({
        method,
        url: route.url,
        perm: cfg.perm ? ([] as string[]).concat(cfg.perm).join(' or ') : null,
        public: !!cfg.public,
        ...(cfg.scope ? { scope: ([] as string[]).concat(cfg.scope).join(' or ') } : {}),
      });
    }
  });

  await app.register(helmet, {
    // The SPA is served by nginx (production) or Vite (development); the API only returns JSON/files.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 10 } });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` } }),
  );

  registerAuthHook(app);

  app.get('/api/health', { config: { public: true } }, async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok', database: 'ok', time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'unreachable' });
    }
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await registerModules(api);
    },
    { prefix: '/api/v1' },
  );
  await app.register(portalRoutes);

  return app;
}

import type { FastifyRequest } from 'fastify';
import type { Permission } from '@taskora/shared';
import { hasPermission } from '@taskora/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { forbidden, unauthorized } from './errors.js';

export interface AuthUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  roleId: number;
  roleKey: string;
  roleName: string;
  permissions: string[];
  timezone: string;
  isTechnician: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
    routeCatalog: { method: string; url: string; perm: string | null; public: boolean; scope?: string }[];
    /** Test hook: replaces the SMTP transport built from the mail settings. */
    mailTransport: import('nodemailer').Transporter | null;
  }
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
    csrfToken: string | null;
    /** Set on integration routes authenticated by a scoped token (never together with `user`). */
    integration: { tokenId: number; name: string; scopes: string[] } | null;
  }
  interface FastifyContextConfig {
    /** Permission(s) required — the user needs at least one of them. */
    perm?: Permission | Permission[];
    /** Route is reachable without a session. */
    public?: boolean;
    /**
     * Integration route: requires `Authorization: Bearer <token>` of an integration token with
     * this scope. Session cookies are ignored on these routes (no CSRF surface).
     */
    scope?: import('@taskora/shared').IntegrationScope | import('@taskora/shared').IntegrationScope[];
  }
}

/** Returns the authenticated user (routes are authenticated by the global hook). */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function can(req: FastifyRequest, perm: Permission): boolean {
  return !!req.user && hasPermission(req.user.permissions, perm);
}

export function assertCan(req: FastifyRequest, perm: Permission): void {
  if (!can(req, perm)) throw forbidden();
}

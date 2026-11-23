import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import { z } from 'zod';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { can, currentUser } from '../../lib/context.js';
import { encryptJson, randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { resolveSmtp } from '../../lib/mail.js';
import { imapHostFor, imapSettingsInputSchema, publicImapSettings, resolveImap, saveImapSettings } from '../../lib/imap-settings.js';
import { idOf } from '../../lib/params.js';
import { emitEvent, WEBHOOK_EVENTS } from '../../lib/webhooks.js';
import { processInboundEmail } from '../../jobs/inbound-email.js';

/**
 * Automation & integration surface: personal API keys (Bearer tka_…), outgoing webhooks,
 * the inbound e-mail mailbox (IMAP) settings and an inbound e-mail endpoint that n8n,
 * Power Automate or a mail provider can call to turn a message into a ticket.
 */

const apiKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  /** Days until expiry; omitted/null = never expires. */
  expiresInDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
});

const eventNames = Object.keys(WEBHOOK_EVENTS) as [string, ...string[]];
const webhookInput = z.object({
  name: z.string().trim().min(1).max(120),
  url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) URL'),
  events: z.array(z.enum(['*', ...eventNames])).min(1, 'Pick at least one event'),
  isActive: z.boolean().default(true),
  /** Omitted keeps the current secret; empty string removes signing; 'generate' creates one. */
  secret: z.string().max(200).optional(),
});

const inboundInput = z.object({
  from: z.string().trim().email().max(320),
  fromName: z.string().trim().max(200).nullable().optional(),
  subject: z.string().max(998).nullable().optional(),
  text: z.string().max(200_000).nullable().optional(),
  /** Provider message id; makes retries idempotent. Generated from the content when omitted. */
  messageId: z.string().trim().max(998).optional(),
  attachments: z
    .array(z.object({ fileName: z.string().min(1).max(200), contentType: z.string().max(200).default('application/octet-stream'), contentBase64: z.string() }))
    .max(20)
    .optional(),
});

export async function developerRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------------ API keys */

  app.get('/api-keys', async (req) => {
    const me = currentUser(req);
    const all = (req.query as { all?: string }).all === 'true' && can(req, 'users.manage');
    const rows = await app.db
      .select({
        id: s.apiKeys.id,
        name: s.apiKeys.name,
        prefix: s.apiKeys.prefix,
        userId: s.apiKeys.userId,
        owner: sql<string>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        createdAt: s.apiKeys.createdAt,
        lastUsedAt: s.apiKeys.lastUsedAt,
        lastUsedIp: s.apiKeys.lastUsedIp,
        expiresAt: s.apiKeys.expiresAt,
        revokedAt: s.apiKeys.revokedAt,
      })
      .from(s.apiKeys)
      .innerJoin(s.users, eq(s.users.id, s.apiKeys.userId))
      .where(all ? undefined : eq(s.apiKeys.userId, me.id))
      .orderBy(desc(s.apiKeys.createdAt));
    return { data: rows };
  });

  app.post('/api-keys', async (req, reply) => {
    const me = currentUser(req);
    const input = apiKeyInput.parse(req.body);
    const token = `tka_${randomToken(32)}`;
    const [row] = await app.db
      .insert(s.apiKeys)
      .values({
        userId: me.id,
        name: input.name,
        prefix: token.slice(0, 12),
        tokenHash: sha256(token),
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null,
      })
      .returning();
    await audit(app.db, req, { action: 'create', entityType: 'api_key', entityId: row!.id, summary: input.name });
    // The only time the full key is returned.
    return reply.status(201).send({ ...row, tokenHash: undefined, token });
  });

  app.delete('/api-keys/:id', async (req) => {
    const me = currentUser(req);
    const [row] = await app.db.select().from(s.apiKeys).where(eq(s.apiKeys.id, idOf(req)));
    if (!row) throw notFound('API key');
    if (row.userId !== me.id && !can(req, 'users.manage')) throw forbidden();
    await app.db.update(s.apiKeys).set({ revokedAt: new Date() }).where(and(eq(s.apiKeys.id, row.id), isNull(s.apiKeys.revokedAt)));
    await audit(app.db, req, { action: 'delete', entityType: 'api_key', entityId: row.id, summary: `Revoked ${row.name}` });
    return { ok: true };
  });

  /* ------------------------------------------------------------ webhooks */

  const W = 'integrations.manage' as const;
  const publicHook = (h: typeof s.webhooks.$inferSelect) => {
    const { secretEncrypted, ...rest } = h;
    return { ...rest, signed: !!secretEncrypted };
  };

  app.get('/webhooks/events', { config: { perm: W } }, async () => ({
    data: Object.entries(WEBHOOK_EVENTS)
      .filter(([k]) => k !== 'webhook.test')
      .map(([event, description]) => ({ event, description })),
  }));

  app.get('/webhooks', { config: { perm: W } }, async () => {
    const rows = await app.db.select().from(s.webhooks).orderBy(s.webhooks.name);
    return { data: rows.map(publicHook) };
  });

  const secretFor = (secret: string | undefined, current: string | null): { enc: string | null; plain: string | null } => {
    if (secret === undefined) return { enc: current, plain: null };
    if (secret === '') return { enc: null, plain: null };
    const plain = secret === 'generate' ? `whsec_${randomToken(24)}` : secret;
    return { enc: encryptJson(app.config.encryptionKey, plain), plain };
  };

  app.post('/webhooks', { config: { perm: W } }, async (req, reply) => {
    const input = webhookInput.parse(req.body);
    const sec = secretFor(input.secret ?? 'generate', null);
    const [row] = await app.db
      .insert(s.webhooks)
      .values({ name: input.name, url: input.url, events: input.events, isActive: input.isActive, secretEncrypted: sec.enc, createdById: currentUser(req).id })
      .returning();
    await audit(app.db, req, { action: 'create', entityType: 'webhook', entityId: row!.id, summary: input.name });
    return reply.status(201).send({ ...publicHook(row!), secret: sec.plain });
  });

  app.patch('/webhooks/:id', { config: { perm: W } }, async (req) => {
    const id = idOf(req);
    const input = webhookInput.partial().parse(req.body);
    const body = req.body as Record<string, unknown>;
    const [before] = await app.db.select().from(s.webhooks).where(eq(s.webhooks.id, id));
    if (!before) throw notFound('Webhook');
    const sec = secretFor('secret' in body ? input.secret : undefined, before.secretEncrypted);
    const data: Partial<typeof s.webhooks.$inferInsert> = { secretEncrypted: sec.enc, updatedAt: new Date() };
    if ('name' in body) data.name = input.name!;
    if ('url' in body) data.url = input.url!;
    if ('events' in body) data.events = input.events!;
    if ('isActive' in body) data.isActive = input.isActive!;
    const [row] = await app.db.update(s.webhooks).set(data).where(eq(s.webhooks.id, id)).returning();
    await audit(app.db, req, { action: 'update', entityType: 'webhook', entityId: id, summary: row!.name });
    return { ...publicHook(row!), secret: sec.plain };
  });

  app.delete('/webhooks/:id', { config: { perm: W } }, async (req) => {
    const [row] = await app.db.delete(s.webhooks).where(eq(s.webhooks.id, idOf(req))).returning();
    if (!row) throw notFound('Webhook');
    await audit(app.db, req, { action: 'delete', entityType: 'webhook', entityId: row.id, summary: row.name });
    return { ok: true };
  });

  /** Queues a test delivery (the worker sends it within a few seconds). */
  app.post('/webhooks/:id/test', { config: { perm: W } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.select({ id: s.webhooks.id }).from(s.webhooks).where(eq(s.webhooks.id, id));
    if (!row) throw notFound('Webhook');
    await emitEvent(app.db, 'webhook.test', { message: 'Hello from Taskora', sentBy: currentUser(req).email }, id);
    return { ok: true, queued: true };
  });

  /* ------------------------------------------------- e-mail to ticket */

  app.get('/settings/imap', { config: { perm: 'settings.manage' } }, async () => {
    const effective = await resolveImap(app.db, app.config);
    return { ...(await publicImapSettings(app.db, app.config)), active: effective ? effective.source : null };
  });

  app.put('/settings/imap', { config: { perm: 'settings.manage' } }, async (req) => {
    const input = imapSettingsInputSchema.parse(req.body);
    if (input.enabled && !input.useSmtpAccount && (!input.host || !input.user)) throw badRequest('Host and user name are required to enable the mailbox');
    if (input.enabled && input.useSmtpAccount) {
      const smtp = await resolveSmtp(app.db, app.config);
      if (!smtp?.user) throw badRequest('Set up the outgoing mailbox (Administration → E-mail) with a user name and password first');
      if (!input.host) input.host = imapHostFor(smtp.host);
    }
    await saveImapSettings(app.db, app.config, input);
    await audit(app.db, req, { action: 'update', entityType: 'settings', summary: 'Inbound e-mail (IMAP) settings' });
    const effective = await resolveImap(app.db, app.config);
    return { ...(await publicImapSettings(app.db, app.config)), active: effective ? effective.source : null };
  });

  /** Connects to the mailbox in effect and reports how many unread messages are waiting. */
  app.post('/settings/imap/test', { config: { perm: 'settings.manage' } }, async () => {
    const imap = await resolveImap(app.db, app.config);
    if (!imap) throw badRequest('No mailbox is configured');
    const client = new ImapFlow({ host: imap.host, port: imap.port, secure: imap.secure, auth: { user: imap.user, pass: imap.password }, logger: false });
    try {
      await client.connect();
      const status = await client.status(imap.mailbox, { messages: true, unseen: true });
      return { ok: true, mailbox: imap.mailbox, messages: status.messages ?? 0, unseen: status.unseen ?? 0 };
    } catch (e) {
      throw badRequest(`Could not connect: ${(e as Error).message}`);
    } finally {
      await client.logout().catch(() => undefined);
    }
  });

  /**
   * Inbound e-mail from automation (n8n "Email trigger", Microsoft Graph, SendGrid inbound parse…):
   * same rules as the IMAP poller — replies with [TKA-…] in the subject are added to that ticket,
   * other messages create a ticket for the sender's company (or the fallback company).
   */
  app.post('/inbound/email', { config: { perm: 'tickets.write' } }, async (req) => {
    const input = inboundInput.parse(req.body);
    const messageId =
      input.messageId ||
      `api-${createHash('sha256')
        .update(`${input.from}\n${input.subject ?? ''}\n${input.text ?? ''}`)
        .digest('hex')
        .slice(0, 32)}`;
    const result = await processInboundEmail(app.db, app.config, {
      messageId,
      fromAddress: input.from,
      fromName: input.fromName ?? null,
      subject: input.subject ?? '',
      text: input.text ?? '',
      attachments: (input.attachments ?? []).map((a) => ({ fileName: a.fileName, contentType: a.contentType, content: Buffer.from(a.contentBase64, 'base64') })),
    });
    return result;
  });
}

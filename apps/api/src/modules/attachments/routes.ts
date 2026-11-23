import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { Permission } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { assertCan, can, currentUser } from '../../lib/context.js';

/** Entity types that accept attachments and the permissions guarding them. */
const ENTITIES: Record<string, { read: Permission; write: Permission; table: { id: any } }> = {
  ticket: { read: 'tickets.read', write: 'tickets.write', table: s.tickets },
  company: { read: 'companies.read', write: 'companies.write', table: s.companies },
  configuration_item: { read: 'cis.read', write: 'cis.write', table: s.configurationItems },
  kb_article: { read: 'kb.read', write: 'kb.write', table: s.kbArticles },
  contract: { read: 'contracts.read', write: 'contracts.write', table: s.contracts },
  project: { read: 'projects.read', write: 'projects.write', table: s.projects },
};

const BLOCKED_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.js', '.jar', '.dll', '.sh', '.hta', '.html', '.htm', '.svg']);
const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

function entityParams(req: FastifyRequest) {
  const { entityType } = req.params as { entityType: string };
  const def = ENTITIES[entityType];
  if (!def) throw badRequest('Attachments are not supported for this record type');
  return { entityType, entityId: idOf(req, 'entityId'), def };
}

export async function attachmentRoutes(app: FastifyInstance) {
  const root = resolve(app.config.UPLOAD_DIR);

  app.get('/attachments/:entityType/:entityId', async (req) => {
    const { entityType, entityId, def } = entityParams(req);
    assertCan(req, def.read);
    const rows = await app.db
      .select({
        file: s.attachments,
        uploadedBy: sql<string | null>`coalesce(${s.users.firstName} || ' ' || ${s.users.lastName}, (select c.first_name || ' ' || c.last_name || ' (client)' from contacts c where c.id = ${s.attachments.uploadedByContactId}))`,
      })
      .from(s.attachments)
      .leftJoin(s.users, eq(s.users.id, s.attachments.uploadedById))
      .where(and(eq(s.attachments.entityType, entityType), eq(s.attachments.entityId, entityId)))
      .orderBy(desc(s.attachments.createdAt));
    return { data: rows.map((r) => ({ ...r.file, storageKey: undefined, uploadedBy: r.uploadedBy })) };
  });

  app.post('/attachments/:entityType/:entityId', async (req, reply) => {
    const { entityType, entityId, def } = entityParams(req);
    assertCan(req, def.write);
    const [exists] = await app.db.select({ id: def.table.id }).from(def.table as never).where(eq(def.table.id, entityId));
    if (!exists) throw notFound('Record');
    const saved: unknown[] = [];
    await mkdir(root, { recursive: true });
    for await (const part of req.files()) {
      const name = part.filename.replace(/[\\/\0]/g, '_').slice(0, 200) || 'file';
      const ext = extname(name).toLowerCase();
      if (BLOCKED_EXT.has(ext)) throw badRequest(`Files of type ${ext} are not allowed`);
      const buf = await part.toBuffer();
      if (part.file.truncated) throw badRequest(`File exceeds the ${app.config.MAX_UPLOAD_MB} MB limit`);
      const key = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}${ext}`;
      const path = join(root, key);
      if (!path.startsWith(root)) throw badRequest('Invalid file name');
      await mkdir(join(root, key.split('/')[0]!), { recursive: true });
      await writeFile(path, buf, { flag: 'wx' });
      const [row] = await app.db
        .insert(s.attachments)
        .values({
          entityType,
          entityId,
          fileName: name,
          mimeType: part.mimetype || 'application/octet-stream',
          sizeBytes: buf.length,
          storageKey: key,
          sha256: createHash('sha256').update(buf).digest('hex'),
          uploadedById: currentUser(req).id,
        })
        .returning();
      if (entityType === 'ticket') {
        await app.db.insert(s.ticketEvents).values({ ticketId: entityId, userId: currentUser(req).id, type: 'attachment_added', data: { fileName: name } });
      }
      await audit(app.db, req, { action: 'create', entityType: 'attachment', entityId: row!.id, summary: `${name} on ${entityType} ${entityId}` });
      saved.push({ ...row!, storageKey: undefined });
    }
    if (!saved.length) throw badRequest('No file received');
    return reply.status(201).send({ data: saved });
  });

  app.get('/attachments/file/:id', async (req, reply) => {
    const [file] = await app.db.select().from(s.attachments).where(eq(s.attachments.id, idOf(req)));
    if (!file) throw notFound('Attachment');
    const def = ENTITIES[file.entityType];
    if (!def || !can(req, def.read)) throw forbidden();
    const path = join(root, file.storageKey);
    if (!path.startsWith(root)) throw forbidden();
    await stat(path).catch(() => {
      throw notFound('File');
    });
    const inline = (req.query as { inline?: string }).inline === 'true' && INLINE_SAFE.has(file.mimeType);
    return reply
      .header('content-type', INLINE_SAFE.has(file.mimeType) ? file.mimeType : 'application/octet-stream')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(createReadStream(path));
  });

  app.delete('/attachments/file/:id', async (req) => {
    const [file] = await app.db.select().from(s.attachments).where(eq(s.attachments.id, idOf(req)));
    if (!file) throw notFound('Attachment');
    const def = ENTITIES[file.entityType];
    if (!def || !can(req, def.write)) throw forbidden();
    if (file.uploadedById !== currentUser(req).id && !can(req, 'settings.manage')) throw forbidden('Only the uploader or an administrator can delete this file');
    await app.db.delete(s.attachments).where(eq(s.attachments.id, file.id));
    await unlink(join(root, file.storageKey)).catch(() => undefined);
    await audit(app.db, req, { action: 'delete', entityType: 'attachment', entityId: file.id, summary: file.fileName });
    return { ok: true };
  });
}

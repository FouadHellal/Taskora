import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { assertCan } from '../../lib/context.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { saveSystemSettings } from '../../lib/settings.js';

/**
 * Logos for client companies and for the organization itself. Only raster
 * formats are accepted (no SVG: it can carry scripts) and the bytes are
 * checked against the declared type.
 */

const MAX_BYTES = 512 * 1024;

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const uploadSchema = z.object({
  /** data:image/png;base64,… as produced by FileReader.readAsDataURL. */
  dataUrl: z.string().max(Math.ceil((MAX_BYTES * 4) / 3) + 100),
});

export function decodeLogo(dataUrl: string): { mimeType: string; data: string } {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw badRequest('Upload a PNG, JPEG, GIF or WebP image');
  const mimeType = m[1]!;
  const bytes = Buffer.from(m[2]!.replace(/\s/g, ''), 'base64');
  if (!bytes.length) throw badRequest('The image is empty');
  if (bytes.length > MAX_BYTES) throw badRequest('The logo must be 512 KB or smaller');
  if (!SIGNATURES[mimeType]!(bytes)) throw badRequest('The file content does not match its image type');
  return { mimeType, data: bytes.toString('base64') };
}

type Kind = 'company' | 'organization' | 'email';

function target(req: FastifyRequest): { kind: Kind; id: number } {
  const { kind } = req.params as { kind: string };
  if (kind === 'organization' || kind === 'email') return { kind, id: 0 };
  if (kind === 'company') return { kind, id: idOf(req) };
  throw notFound('Logo');
}

export async function logoRoutes(app: FastifyInstance) {
  async function serve(kind: Kind, id: number, reply: import('fastify').FastifyReply) {
    const [logo] = await app.db.select().from(s.logos).where(and(eq(s.logos.entityType, kind), eq(s.logos.entityId, id)));
    if (!logo) throw notFound('Logo');
    return reply
      .header('content-type', logo.mimeType)
      .header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'")
      .send(Buffer.from(logo.data, 'base64'));
  }

  // The organization logo is shown on the sign-in pages, so it is public.
  app.get('/logos/organization', { config: { public: true } }, async (_req, reply) => serve('organization', 0, reply));
  // The e-mail logo is shown in e-mails and HTML signatures, so it is public too.
  app.get('/logos/email', { config: { public: true } }, async (_req, reply) => serve('email', 0, reply));
  app.get('/logos/company/:id', { config: { perm: 'companies.read' } }, async (req, reply) => serve('company', idOf(req), reply));

  app.put('/logos/:kind/:id?', async (req) => {
    const t = target(req);
    assertCan(req, t.kind === 'company' ? 'companies.write' : 'settings.manage');
    const { mimeType, data } = decodeLogo(uploadSchema.parse(req.body).dataUrl);
    const now = new Date();
    await app.db.transaction(async (tx) => {
      if (t.kind === 'company') {
        const [row] = await tx.update(s.companies).set({ logoUpdatedAt: now }).where(eq(s.companies.id, t.id)).returning({ id: s.companies.id, name: s.companies.name });
        if (!row) throw notFound('Company');
        await audit(tx, req, { action: 'update', entityType: 'company', entityId: t.id, summary: `Logo updated for ${row.name}` });
      } else if (t.kind === 'email') {
        await saveSystemSettings(tx, { emailLogoUpdatedAt: now.toISOString() });
        await audit(tx, req, { action: 'update', entityType: 'system_settings', summary: 'E-mail logo updated' });
      } else {
        await saveSystemSettings(tx, { logoUpdatedAt: now.toISOString() });
        await audit(tx, req, { action: 'update', entityType: 'system_settings', summary: 'Organization logo updated' });
      }
      await tx
        .insert(s.logos)
        .values({ entityType: t.kind, entityId: t.id, mimeType, data, updatedAt: now })
        .onConflictDoUpdate({ target: [s.logos.entityType, s.logos.entityId], set: { mimeType, data, updatedAt: now } });
    });
    return { ok: true, logoUpdatedAt: now.toISOString() };
  });

  app.delete('/logos/:kind/:id?', async (req) => {
    const t = target(req);
    assertCan(req, t.kind === 'company' ? 'companies.write' : 'settings.manage');
    await app.db.transaction(async (tx) => {
      await tx.delete(s.logos).where(and(eq(s.logos.entityType, t.kind), eq(s.logos.entityId, t.id)));
      if (t.kind === 'company') await tx.update(s.companies).set({ logoUpdatedAt: null }).where(eq(s.companies.id, t.id));
      else if (t.kind === 'email') await saveSystemSettings(tx, { emailLogoUpdatedAt: null });
      else await saveSystemSettings(tx, { logoUpdatedAt: null });
      await audit(tx, req, { action: 'delete', entityType: t.kind === 'company' ? 'company' : 'system_settings', entityId: t.kind === 'company' ? t.id : null, summary: 'Logo removed' });
    });
    return { ok: true };
  });
}

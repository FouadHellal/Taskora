/**
 * Cross-repository end-to-end harness for the atlas integration (docs/integrations/atlas.md).
 *
 * Starts the real Taskora API on 127.0.0.1 (random port) over an in-memory PostgreSQL
 * (PGlite, migrated + base seed), with test-only data: a "Homelab" company, an Action1-managed
 * CI, a technician, atlas settings and a scoped integration token. Writes how to reach it to
 * the JSON file given as the first argument, then runs until stdin closes or SIGTERM.
 *
 *   npx tsx test/e2e/atlas-e2e-server.ts <handoff.json>
 *
 * Used by atlas's tests/integration/test_taskora_e2e.py. Development only; never deployed.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { formatNumber } from '@taskora/shared';
import { schema as s } from '../../src/db/client.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { nextSequence } from '../../src/lib/query.js';
import { createTestApp, makeCompany, userClient } from '../helpers.js';

const out = process.argv[2];
if (!out) throw new Error('usage: atlas-e2e-server.ts <handoff.json>');

const ctx = await createTestApp();
const admin = await userClient(ctx, 'administrator');
const company = await makeCompany(admin, 'Homelab');

// A technician whose password exists only for this run.
const techPassword = `e2e-${randomBytes(12).toString('base64url')}`;
const techEmail = 'tech@homelab.example.test';
const [techRole] = await ctx.db.select().from(s.roles).where(eq(s.roles.key, 'technician'));
const [tech] = await ctx.db
  .insert(s.users)
  .values({ email: techEmail, firstName: 'Sam', lastName: 'Tech', passwordHash: await hashPassword(techPassword), roleId: techRole!.id })
  .returning();

// docker01 is managed by Action1 (same MAC as atlas sees on VM 101).
const [server] = await ctx.db.select().from(s.ciTypes).where(eq(s.ciTypes.name, 'Server'));
const [a1ci] = await ctx.db
  .insert(s.configurationItems)
  .values({ ciNumber: formatNumber('CI-', await nextSequence(ctx.db, 'ci')), name: 'DOCKER01', hostname: 'docker01', ciTypeId: server!.id, companyId: company.id, source: 'action1', macAddress: 'BC:24:11:46:66:CA', osName: 'Debian 12 (reported by Action1)', ipAddress: '10.0.20.11' })
  .returning();
await ctx.db.insert(s.action1Endpoints).values({ externalId: 'e2e-ep-docker01', orgExternalId: 'e2e-org', configurationItemId: a1ci!.id, name: 'DOCKER01', macAddress: 'BC:24:11:46:66:CA', matchStatus: 'matched' });

const lookups = (await admin.get('/api/v1/lookups')).body as { priorities: { id: number; name: string }[] };
const prio = (n: string) => lookups.priorities.find((p) => p.name === n)?.id ?? null;
const current = (await admin.get('/api/v1/integrations/atlas/settings')).body.settings;
const saved = await admin.put('/api/v1/integrations/atlas/settings', {
  ...current,
  enabled: true,
  companyId: company.id,
  cmdbMode: 'link_and_create',
  atlasBaseUrl: 'https://atlas.e2e.test',
  priorityMap: { info: prio('Low'), notice: prio('Medium'), warning: prio('High') },
});
if (saved.status !== 200) throw new Error(JSON.stringify(saved.body));
const token = await admin.post('/api/v1/integrations/tokens', { name: 'atlas e2e', scopes: ['atlas.incidents', 'atlas.cmdb'] });
if (token.status !== 201) throw new Error(JSON.stringify(token.body));

// Loopback only. E2E_PORT pins the port (e.g. to put the Vite dev server in front of it).
const address = await ctx.app.listen({ host: '127.0.0.1', port: Number(process.env.E2E_PORT ?? 0) });
writeFileSync(
  out,
  JSON.stringify({ url: address, token: token.body.token, techEmail, techPassword, techId: tech!.id, companyId: company.id, action1CiId: a1ci!.id }),
);
console.log(`taskora e2e listening on ${address}`);

const stop = async () => {
  await ctx.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
process.stdin.resume();

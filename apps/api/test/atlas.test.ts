/**
 * atlas integration (docs/integrations/atlas.md): token auth, idempotent incident → ticket,
 * lifecycle mapping, feed without echo, CMDB reconciliation with Action1 ownership.
 * All data below is fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { formatNumber } from '@taskora/shared';
import { schema as s } from '../src/db/client.js';
import { nextSequence } from '../src/lib/query.js';
import { createTestApp, makeCompany, userClient, type Client, type TestContext } from './helpers.js';

let ctx: TestContext;
let admin: Client & { userId: number };
let tech: Client & { userId: number };
let lookups: any;
let companyId: number;
let incidentToken: string;
let cmdbToken: string;
const INSTANCE = 'atlas-home';
const statusId = (name: string) => lookups.statuses.find((x: { name: string }) => x.name === name).id;
const priorityId = (name: string) => lookups.priorities.find((x: { name: string }) => x.name === name).id;

async function call(app: FastifyInstance, method: 'GET' | 'PUT' | 'POST', url: string, token: string | null, payload?: unknown, extra: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: payload as never, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });
  let body: any = res.body;
  try {
    body = res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode, body };
}

let rev = 0;
function incident(id: number, over: Record<string, unknown> = {}) {
  return {
    instance: INSTANCE,
    incidentId: id,
    revision: ++rev,
    fingerprint: `media.storage:media`,
    kind: 'media.storage',
    title: 'Jellyfin runs, but its media storage is not mounted',
    summary: 'The NFS share is missing on media01.',
    severity: 'warning',
    state: 'open',
    firstObservedAt: '2026-11-03T01:00:00Z',
    lastObservedAt: '2026-11-03T01:05:00Z',
    entity: { key: 'pve:lxc:homelab/204', name: 'media01', kind: 'pve-lxc', hostname: 'media01', ips: ['10.0.20.55'], macs: ['bc:24:11:00:02:04'], pveNode: 'pve2', vmid: 204 },
    checks: [{ name: 'Library folders are on mounted network storage', state: 'fail', detail: '/mnt/media/movies is on / (ext4)' }],
    evidence: ['mount /mnt/media removed'],
    link: 'https://atlas.lan/incidents',
    ...over,
  };
}
const put = (body: ReturnType<typeof incident>, token = incidentToken) =>
  call(ctx.app, 'PUT', `/api/v1/integrations/atlas/v1/incidents/${body.instance}:${body.incidentId}`, token, body);

function entity(key: string, over: Record<string, unknown> = {}) {
  return { key, name: key, kind: 'pve-vm', ips: [], macs: [], status: 'running', observedAt: '2026-11-03T01:00:00Z', apps: [], ...over };
}
const sync = (body: Record<string, unknown>, token = cmdbToken) => call(ctx.app, 'POST', '/api/v1/integrations/atlas/v1/inventory', token, { instance: INSTANCE, ...body });

async function settings(over: Record<string, unknown> = {}) {
  const current = (await admin.get('/api/v1/integrations/atlas/settings')).body.settings;
  const res = await admin.put('/api/v1/integrations/atlas/settings', { ...current, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function ci(name: string, over: Partial<typeof s.configurationItems.$inferInsert> = {}) {
  const [type] = await ctx.db.select().from(s.ciTypes).where(eq(s.ciTypes.name, 'Server'));
  const [row] = await ctx.db
    .insert(s.configurationItems)
    .values({ ciNumber: formatNumber('CI-', await nextSequence(ctx.db, 'ci')), name, ciTypeId: type!.id, companyId, ...over })
    .returning();
  return row!;
}

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  tech = await userClient(ctx, 'technician');
  lookups = (await admin.get('/api/v1/lookups')).body;
  companyId = (await makeCompany(admin, 'Homelab')).id;
  const a = await admin.post('/api/v1/integrations/tokens', { name: 'atlas incidents', scopes: ['atlas.incidents'] });
  expect(a.status).toBe(201);
  incidentToken = a.body.token;
  cmdbToken = (await admin.post('/api/v1/integrations/tokens', { name: 'atlas cmdb', scopes: ['atlas.cmdb'] })).body.token;
});
afterAll(async () => ctx.close());

describe('integration tokens', () => {
  it('are shown once, stored hashed, and only accepted on their scope', async () => {
    const [row] = await ctx.db.select().from(s.integrationTokens).where(eq(s.integrationTokens.name, 'atlas incidents'));
    expect(row!.tokenHash).not.toContain(incidentToken);
    expect(incidentToken.startsWith('tki_')).toBe(true);
    const list = await admin.get('/api/v1/integrations/tokens');
    expect(JSON.stringify(list.body)).not.toContain(incidentToken);

    expect((await call(ctx.app, 'GET', '/api/v1/integrations/atlas/v1/health', null)).status).toBe(401);
    expect((await call(ctx.app, 'GET', '/api/v1/integrations/atlas/v1/health', 'tki_' + 'x'.repeat(43))).status).toBe(401);
    expect((await call(ctx.app, 'GET', '/api/v1/integrations/atlas/v1/health', incidentToken)).status).toBe(200);
    // Wrong scope: the CMDB token cannot send incidents, the incident token cannot sync.
    expect((await put(incident(900), cmdbToken)).status).toBe(403);
    expect((await sync({ entities: [] }, incidentToken)).status).toBe(403);
  });

  it('ignores session cookies on the machine API and needs a permission to manage tokens', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/atlas/v1/health', headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(401);
    expect((await tech.post('/api/v1/integrations/tokens', { name: 'x', scopes: ['atlas.cmdb'] })).status).toBe(403);
    expect((await tech.put('/api/v1/integrations/atlas/settings', {})).status).toBe(403);
  });

  it('can be revoked and can expire', async () => {
    const t = await admin.post('/api/v1/integrations/tokens', { name: 'short', scopes: ['atlas.incidents'] });
    expect((await call(ctx.app, 'GET', '/api/v1/integrations/atlas/v1/health', t.body.token)).status).toBe(200);
    expect((await admin.delete(`/api/v1/integrations/tokens/${t.body.id}`)).status).toBe(200);
    expect((await call(ctx.app, 'GET', '/api/v1/integrations/atlas/v1/health', t.body.token)).status).toBe(401);
    const old = await admin.post('/api/v1/integrations/tokens', { name: 'old', scopes: ['atlas.incidents'], expiresAt: '2020-01-01T00:00:00Z' });
    expect((await call(ctx.app, 'GET', '/api/v1/integrations/atlas/v1/health', old.body.token)).status).toBe(401);
  });
});

describe('incident → ticket', () => {
  it('refuses incidents while disabled or without a company, and test events never create tickets', async () => {
    expect((await put(incident(1))).status).toBe(409);
    // The refusal is visible to the admin, not only to atlas.
    expect((await admin.get('/api/v1/integrations/atlas/settings')).body.status.lastError).toMatch(/disabled/);
    await settings({ enabled: true });
    const noCompany = await put(incident(1));
    expect(noCompany.status).toBe(409);
    expect(noCompany.body.error.message).toMatch(/company/);
    const test = await put(incident(999, { test: true }));
    expect(test.status).toBe(200);
    expect(test.body.test).toBe(true);
    expect(await ctx.db.select().from(s.tickets)).toHaveLength(0);
  });

  it('creates exactly one ticket per incident, linked to the CI, and ignores replays', async () => {
    await settings({ companyId, cmdbMode: 'link_and_create', priorityMap: { info: priorityId('Low'), notice: priorityId('Medium'), warning: priorityId('High') } });
    // The CMDB knows media01 (created from atlas inventory).
    expect((await sync({ mode: 'apply', entities: [entity('pve:lxc:homelab/204', { name: 'media01', kind: 'pve-lxc', macs: ['bc:24:11:00:02:04'] })] })).status).toBe(200);
    const first = incident(1);
    const created = await put(first);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.created).toBe(true);
    expect(created.body.ticket.priority).toBe('High');
    expect(created.body.ticket.ciNumber).toMatch(/^CI-/);
    const [t] = await ctx.db.select().from(s.tickets).where(eq(s.tickets.id, created.body.ticket.id));
    expect(t!.description).toContain('media01');
    expect(t!.tags).toContain('atlas');

    // Same revision again (lost response, retry, duplicate delivery): nothing new.
    const replay = await put(first);
    expect(replay.status).toBe(200);
    expect(replay.body.applied).toBe(false);
    expect(replay.body.ticket.id).toBe(created.body.ticket.id);
    // Two concurrent deliveries of a new incident still make one ticket.
    const [a, b] = await Promise.all([put(incident(2, { title: 'pve2 does not answer SSH' })), put(incident(2, { title: 'pve2 does not answer SSH' }))]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await ctx.db.select().from(s.atlasIncidentLinks)).toHaveLength(2);
    expect(await ctx.db.select().from(s.tickets)).toHaveLength(2);
    // Lookup for reconciliation.
    const look = await call(ctx.app, 'GET', `/api/v1/integrations/atlas/v1/incidents/${INSTANCE}:1`, incidentToken);
    expect(look.body.ticket.id).toBe(created.body.ticket.id);
  });

  it('adds internal notes for meaningful changes, follows severity unless a technician changed it', async () => {
    const [link] = await ctx.db.select().from(s.atlasIncidentLinks).where(eq(s.atlasIncidentLinks.externalKey, `${INSTANCE}:1`));
    const ticketId = link!.ticketId!;
    const notesBefore = (await ctx.db.select().from(s.ticketNotes).where(eq(s.ticketNotes.ticketId, ticketId))).length;
    // Heartbeat only (new lastObservedAt): no note.
    await put(incident(1, { lastObservedAt: '2026-11-03T01:10:00Z' }));
    expect(await ctx.db.select().from(s.ticketNotes).where(eq(s.ticketNotes.ticketId, ticketId))).toHaveLength(notesBefore);
    // New evidence: one internal note.
    await put(incident(1, { evidence: ['mount /mnt/media removed', 'Library scan failed: access denied'] }));
    const notes = await ctx.db.select().from(s.ticketNotes).where(eq(s.ticketNotes.ticketId, ticketId));
    expect(notes).toHaveLength(notesBefore + 1);
    expect(notes.at(-1)!.visibility).toBe('internal');
    // A technician lowers the priority; a later severity change does not override them.
    expect((await tech.patch(`/api/v1/tickets/${ticketId}`, { priorityId: priorityId('Low') })).status).toBe(200);
    await put(incident(1, { severity: 'notice' }));
    const [t] = await ctx.db.select().from(s.tickets).where(eq(s.tickets.id, ticketId));
    expect(t!.priorityId).toBe(priorityId('Low'));
  });

  it('feeds technician actions back, without echoing what atlas did', async () => {
    const [link] = await ctx.db.select().from(s.atlasIncidentLinks).where(eq(s.atlasIncidentLinks.externalKey, `${INSTANCE}:1`));
    expect((await tech.patch(`/api/v1/tickets/${link!.ticketId}`, { statusId: statusId('In Progress'), assignedUserId: tech.userId })).status).toBe(200);
    const feed = await call(ctx.app, 'GET', '/api/v1/integrations/atlas/v1/ticket-events?after=0', incidentToken);
    expect(feed.status).toBe(200);
    const types = feed.body.events.filter((e: any) => e.externalKey === `${INSTANCE}:1`).map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['status_changed', 'assigned', 'field_changed']));
    expect(types).not.toContain('created'); // atlas created it
    expect(feed.body.events.every((e: any) => e.actor !== 'Automation' || e.automation)).toBe(true);
    const again = await call(ctx.app, 'GET', `/api/v1/integrations/atlas/v1/ticket-events?after=${feed.body.nextCursor}`, incidentToken);
    expect(again.body.events).toHaveLength(0);
  });

  it('recovery resolves the ticket, a technician closing it does not prove recovery, a relapse reopens it', async () => {
    const [link] = await ctx.db.select().from(s.atlasIncidentLinks).where(eq(s.atlasIncidentLinks.externalKey, `${INSTANCE}:2`));
    const ticketId = link!.ticketId!;
    const category = async () => {
      const [row] = await ctx.db.select({ c: s.ticketStatuses.category }).from(s.tickets).innerJoin(s.ticketStatuses, eq(s.ticketStatuses.id, s.tickets.statusId)).where(eq(s.tickets.id, ticketId));
      return row!.c;
    };
    // Technician resolves while atlas still sees the problem: atlas says so, the ticket reopens.
    expect((await tech.patch(`/api/v1/tickets/${ticketId}`, { statusId: statusId('Resolved') })).status).toBe(200);
    expect(await category()).toBe('resolved');
    await put(incident(2, { title: 'pve2 does not answer SSH', persisting: true }));
    expect(await category()).toBe('open');
    // atlas verifies recovery: resolved by policy, with an internal note.
    const ok = await put(incident(2, { title: 'pve2 does not answer SSH', state: 'resolved', resolvedAt: '2026-11-03T02:00:00Z', persisting: false }));
    expect(ok.body.ticket.statusCategory).toBe('resolved');
    // Relapse within the incident: reopened.
    await put(incident(2, { title: 'pve2 does not answer SSH', state: 'open' }));
    expect(await category()).toBe('open');
    // An out-of-order older revision changes nothing.
    const stale = await put({ ...incident(2), revision: 1 });
    expect(stale.body.applied).toBe(false);
  });

  it('accepts POST as an alias of PUT (same idempotent semantics)', async () => {
    const ev = incident(1, { lastObservedAt: '2026-11-03T03:00:00Z' });
    const res = await call(ctx.app, 'POST', `/api/v1/integrations/atlas/v1/incidents/${INSTANCE}:1`, incidentToken, ev);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect((await call(ctx.app, 'POST', `/api/v1/integrations/atlas/v1/incidents/${INSTANCE}:1`, incidentToken, ev)).body.applied).toBe(false);
    expect(await ctx.db.select().from(s.atlasIncidentLinks).where(eq(s.atlasIncidentLinks.externalKey, `${INSTANCE}:1`))).toHaveLength(1);
  });

  it('validates input strictly', async () => {
    expect((await call(ctx.app, 'PUT', `/api/v1/integrations/atlas/v1/incidents/${INSTANCE}:5`, incidentToken, { ...incident(6) })).status).toBe(400);
    expect((await call(ctx.app, 'PUT', `/api/v1/integrations/atlas/v1/incidents/bad key`, incidentToken, incident(5))).status).toBe(400);
    expect((await put(incident(7, { severity: 'catastrophic' }))).status).toBe(400);
    expect((await put(incident(7, { link: 'javascript:alert(1)' }))).status).toBe(400);
    const big = await call(ctx.app, 'PUT', `/api/v1/integrations/atlas/v1/incidents/${INSTANCE}:8`, incidentToken, { ...incident(8), summary: 'x'.repeat(300 * 1024) });
    expect(big.status).toBe(413);
  });
});

describe('CMDB reconciliation', () => {
  it('preview writes nothing', async () => {
    const before = (await ctx.db.select().from(s.configurationItems)).length;
    const res = await sync({ mode: 'preview', entities: [entity('pve:vm:homelab/300', { name: 'preview01' })] });
    expect(res.body.mode).toBe('preview');
    expect(res.body.plan[0].action).toBe('create');
    expect(await ctx.db.select().from(s.configurationItems)).toHaveLength(before);
    expect(await ctx.db.select().from(s.atlasEntities).where(eq(s.atlasEntities.entityKey, 'pve:vm:homelab/300'))).toHaveLength(0);
  });

  it('links an Action1-managed PC by MAC instead of duplicating it, and never writes Action1 fields', async () => {
    const pc = await ci('NS-DESK-021', { hostname: 'ns-desk-021', source: 'action1', osName: 'Windows 11', macAddress: '3c:52:82:00:00:21', ipAddress: '10.20.30.121' });
    await ctx.db.insert(s.action1Endpoints).values({ externalId: 'ep-21', orgExternalId: 'org-1', configurationItemId: pc.id, name: 'NS-DESK-021', macAddress: '3C:52:82:00:00:21', matchStatus: 'matched' });
    const res = await sync({ mode: 'apply', entities: [entity('unifi:client:3c:52:82:00:00:21', { name: 'desk', kind: 'client', ips: ['10.20.30.200'], macs: ['3c:52:82:00:00:21'], os: 'Linux?' })] });
    expect(res.body.plan[0]).toMatchObject({ action: 'link', ciId: pc.id });
    const [after] = await ctx.db.select().from(s.configurationItems).where(eq(s.configurationItems.id, pc.id));
    expect(after).toMatchObject({ name: 'NS-DESK-021', ipAddress: '10.20.30.121', osName: 'Windows 11', source: 'action1' });
    // Second sync: observation update only, still one CI.
    const again = await sync({ mode: 'apply', entities: [entity('unifi:client:3c:52:82:00:00:21', { name: 'desk', kind: 'client', macs: ['3c:52:82:00:00:21'] })] });
    expect(again.body.plan[0].action).toBe('update');
    expect(again.body.plan[0].note).toMatch(/Action1/);
  });

  it('creates unmanaged infrastructure as atlas CIs, follows renames and IP changes, no duplicates', async () => {
    const vm = entity('pve:vm:homelab/105', { name: 'zabbix', hostname: 'zabbix', kind: 'pve-vm', ips: ['10.10.10.221'], macs: ['bc:24:11:00:01:05'], pveNode: 'pve1', vmid: 105 });
    const sw = entity('unifi:dev:f4:92:bf:00:00:02', { name: 'USW-Fouad', kind: 'unifi-switch', macs: ['f4:92:bf:00:00:02'] });
    const res = await sync({ mode: 'apply', entities: [vm, sw], relations: [{ from: vm.key, to: sw.key, type: 'connected_to', detail: 'port 5' }] });
    const [vmPlan, swPlan] = res.body.plan;
    expect(vmPlan.action).toBe('create');
    expect(swPlan.action).toBe('create');
    const [vmCi] = await ctx.db.select().from(s.configurationItems).where(eq(s.configurationItems.id, vmPlan.ciId));
    expect(vmCi).toMatchObject({ source: 'atlas', hostname: 'zabbix', ipAddress: '10.10.10.221' });
    const [type] = await ctx.db.select().from(s.ciTypes).where(eq(s.ciTypes.id, vmCi!.ciTypeId));
    expect(type!.name).toBe('Virtual Machine');
    const rels = await ctx.db.select().from(s.ciRelations).where(eq(s.ciRelations.ciId, vmPlan.ciId));
    expect(rels).toMatchObject([{ relatedCiId: swPlan.ciId, type: 'connected_to', source: 'atlas', sourceDetail: 'port 5' }]);

    // Rename + new IP: same CI, previous name kept.
    const renamed = await sync({ mode: 'apply', entities: [{ ...vm, name: 'zabbix7', hostname: 'zabbix7', ips: ['10.10.10.222'] }, sw] });
    expect(renamed.body.plan[0]).toMatchObject({ action: 'update', ciId: vmPlan.ciId });
    const [row] = await ctx.db.select().from(s.atlasEntities).where(eq(s.atlasEntities.entityKey, vm.key));
    expect(row!.previousNames).toContain('zabbix');
    const [ci2] = await ctx.db.select().from(s.configurationItems).where(eq(s.configurationItems.id, vmPlan.ciId));
    expect(ci2).toMatchObject({ name: 'zabbix7', ipAddress: '10.10.10.222' });
    expect(await ctx.db.select().from(s.configurationItems).where(eq(s.configurationItems.source, 'atlas'))).toHaveLength(3); // media01, zabbix7, switch
  });

  it('keeps manual CIs and relations, proposes name-only matches, flags ambiguity', async () => {
    const manual = await ci('backup01', { hostname: 'backup01', notes: 'Hand-written notes', ipAddress: '10.0.20.40' });
    const res = await sync({ mode: 'apply', entities: [entity('pve:lxc:homelab/202', { name: 'backup01', hostname: 'backup01', kind: 'pve-lxc' })] });
    expect(res.body.plan[0].action).toBe('propose');
    const [after] = await ctx.db.select().from(s.configurationItems).where(eq(s.configurationItems.id, manual.id));
    expect(after!.notes).toBe('Hand-written notes');
    // Accept the proposal: linked, the CI's own fields stay as they were.
    const [row] = await ctx.db.select().from(s.atlasEntities).where(eq(s.atlasEntities.entityKey, 'pve:lxc:homelab/202'));
    expect((await admin.post(`/api/v1/integrations/atlas/entities/${row!.id}/resolve`, { action: 'link', configurationItemId: manual.id })).status).toBe(200);
    await sync({ mode: 'apply', entities: [entity('pve:lxc:homelab/202', { name: 'backup01', hostname: 'backup01', ips: ['10.0.20.99'], kind: 'pve-lxc' })] });
    const [kept] = await ctx.db.select().from(s.configurationItems).where(eq(s.configurationItems.id, manual.id));
    expect(kept).toMatchObject({ ipAddress: '10.0.20.40', source: 'manual' });

    // Two CIs with the same MAC: a conflict, never a guess.
    await ci('dup-a', { macAddress: 'aa:aa:aa:00:00:01' });
    await ci('dup-b', { macAddress: 'aa:aa:aa:00:00:01' });
    const amb = await sync({ mode: 'apply', entities: [entity('host:x', { name: 'mystery', kind: 'linux-host', macs: ['aa:aa:aa:00:00:01'] })] });
    expect(amb.body.plan[0].action).toBe('conflict');
    const list = await admin.get('/api/v1/integrations/atlas/entities?status=conflict');
    expect(list.body.data.map((e: any) => e.name)).toContain('mystery');
  });

  it('a later Action1 enrolment is detected as the same device, for review', async () => {
    const [row] = await ctx.db.select().from(s.atlasEntities).where(eq(s.atlasEntities.entityKey, 'pve:vm:homelab/105'));
    const pc = await ci('ZABBIX7', { source: 'action1', macAddress: 'bc:24:11:00:01:05' });
    await ctx.db.update(s.configurationItems).set({ macAddress: null }).where(eq(s.configurationItems.id, row!.configurationItemId!));
    await ctx.db.insert(s.action1Endpoints).values({ externalId: 'ep-zbx', orgExternalId: 'org-1', configurationItemId: pc.id, name: 'ZABBIX7', macAddress: 'BC:24:11:00:01:05', matchStatus: 'created' });
    const res = await sync({ mode: 'apply', entities: [entity('pve:vm:homelab/105', { name: 'zabbix7', kind: 'pve-vm', macs: ['bc:24:11:00:01:05'] })] });
    expect(res.body.plan[0].action).toBe('conflict');
    expect(res.body.plan[0].note).toMatch(/Action1/);
    // Re-link: the entity moves to the Action1 CI; tickets keep their history.
    expect((await admin.post(`/api/v1/integrations/atlas/entities/${row!.id}/resolve`, { action: 'link', configurationItemId: pc.id })).status).toBe(200);
    const again = await sync({ mode: 'apply', entities: [entity('pve:vm:homelab/105', { name: 'zabbix7', kind: 'pve-vm', macs: ['bc:24:11:00:01:05'] })] });
    expect(again.body.plan[0]).toMatchObject({ action: 'update', ciId: pc.id });
  });

  it('a complete snapshot flags missing entities and drops stale atlas relations, deletes no CI', async () => {
    const cis = (await ctx.db.select().from(s.configurationItems)).length;
    const manualRel = await ctx.db.select().from(s.ciRelations).where(eq(s.ciRelations.source, 'manual'));
    const res = await sync({ mode: 'apply', complete: true, entities: [entity('pve:lxc:homelab/204', { name: 'media01', kind: 'pve-lxc', macs: ['bc:24:11:00:02:04'], vmid: 204 })] });
    expect(res.body.stats.missing).toBeGreaterThan(0);
    expect(await ctx.db.select().from(s.configurationItems)).toHaveLength(cis);
    const [vm] = await ctx.db.select().from(s.atlasEntities).where(eq(s.atlasEntities.entityKey, 'pve:vm:homelab/105'));
    expect(vm!.missingSince).not.toBeNull();
    expect(await ctx.db.select().from(s.ciRelations).where(and(eq(s.ciRelations.source, 'atlas')))).toHaveLength(0);
    expect(await ctx.db.select().from(s.ciRelations).where(eq(s.ciRelations.source, 'manual'))).toHaveLength(manualRel.length);
    const runs = await admin.get('/api/v1/integrations/atlas/runs');
    expect(runs.body.data.length).toBeGreaterThan(0);
  });

  it('shows the atlas panel on tickets and CIs', async () => {
    const [link] = await ctx.db.select().from(s.atlasIncidentLinks).where(eq(s.atlasIncidentLinks.externalKey, `${INSTANCE}:1`));
    const panel = await tech.get(`/api/v1/tickets/${link!.ticketId}/atlas`);
    expect(panel.status).toBe(200);
    expect(panel.body.link.externalKey).toBe(`${INSTANCE}:1`);
    expect(panel.body.entity.name).toBe('media01');
    const ciPanel = await tech.get(`/api/v1/configuration-items/${link!.configurationItemId}/atlas`);
    expect(ciPanel.body.entity.vmid).toBe(204);
    expect(ciPanel.body.incidents.length).toBeGreaterThan(0);
  });
});

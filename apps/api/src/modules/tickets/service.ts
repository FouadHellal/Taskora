import { and, asc, eq, sql } from 'drizzle-orm';
import { formatNumber, type TicketInput, ticketSchema } from '@taskora/shared';
import type { z } from 'zod';
import type { Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { nextSequence } from '../../lib/query.js';
import { getSystemSettings } from '../../lib/settings.js';
import { validateCustomFields } from '../../lib/custom-fields.js';
import { notifyFromTemplate } from '../notifications/service.js';
import { computeDueDates, pausedBusinessMinutes, resolveSlaId } from './sla.js';

export type TicketRow = typeof s.tickets.$inferSelect;
type ParsedTicket = z.infer<typeof ticketSchema>;

export interface TicketCtx {
  db: Tx;
  userId: number | null;
  /** True when the change originates from a workflow rule (prevents rule loops). */
  automation?: boolean;
  /**
   * Integration that caused the change (e.g. 'atlas'). Stored on the ticket events so the
   * integration's own feed can skip them: no echo, no update loops between applications.
   */
  origin?: string;
  now?: Date;
}

const origin = (ctx: TicketCtx) => (ctx.origin ? { origin: ctx.origin } : {});

const TRACKED: (keyof TicketRow)[] = [
  'title',
  'description',
  'companyId',
  'contactId',
  'locationId',
  'configurationItemId',
  'assignedUserId',
  'queueId',
  'ticketTypeId',
  'issueTypeId',
  'subIssueTypeId',
  'statusId',
  'priorityId',
  'sourceId',
  'slaId',
  'contractId',
  'projectId',
  'dueAt',
  'estimatedHours',
  'resolution',
  'tags',
  'customFields',
];

async function statusById(db: Tx, id: number) {
  const [st] = await db.select().from(s.ticketStatuses).where(eq(s.ticketStatuses.id, id));
  if (!st) throw badRequest('Unknown status', { fields: { statusId: 'Unknown status' } });
  return st;
}

/** Validates that every linked record exists and belongs to the ticket's company. */
async function validateRefs(db: Tx, t: Partial<ParsedTicket> & { companyId: number }) {
  const [company] = await db.select({ id: s.companies.id }).from(s.companies).where(eq(s.companies.id, t.companyId));
  if (!company) throw badRequest('Unknown company', { fields: { companyId: 'Unknown company' } });
  const check = async (id: number | null | undefined, table: typeof s.contacts | typeof s.locations | typeof s.configurationItems | typeof s.contracts | typeof s.projects, field: string, label: string) => {
    if (!id) return;
    const [row] = await db.select({ companyId: table.companyId }).from(table as typeof s.contacts).where(eq(table.id, id));
    if (!row) throw badRequest(`Unknown ${label}`, { fields: { [field]: `Unknown ${label}` } });
    if (row.companyId !== t.companyId) throw badRequest(`The ${label} belongs to another company`, { fields: { [field]: `${label} belongs to another company` } });
  };
  await check(t.contactId, s.contacts, 'contactId', 'contact');
  await check(t.locationId, s.locations, 'locationId', 'location');
  await check(t.configurationItemId, s.configurationItems, 'configurationItemId', 'configuration item');
  await check(t.contractId, s.contracts, 'contractId', 'contract');
  await check(t.projectId, s.projects, 'projectId', 'project');
  if (t.subIssueTypeId) {
    const [sub] = await db.select().from(s.subIssueTypes).where(eq(s.subIssueTypes.id, t.subIssueTypeId));
    if (!sub) throw badRequest('Unknown sub-issue type');
    if (t.issueTypeId && sub.issueTypeId !== t.issueTypeId) {
      throw badRequest('Sub-issue type does not belong to the issue type', { fields: { subIssueTypeId: 'Does not match the issue type' } });
    }
  }
}

async function defaultContractId(db: Tx, companyId: number): Promise<number | null> {
  const [c] = await db
    .select({ id: s.contracts.id })
    .from(s.contracts)
    .where(and(eq(s.contracts.companyId, companyId), eq(s.contracts.isDefault, true), eq(s.contracts.status, 'active')))
    .limit(1);
  return c?.id ?? null;
}

async function event(db: Tx, ticketId: number, userId: number | null, type: string, data: Record<string, unknown> = {}, at?: Date) {
  await db.insert(s.ticketEvents).values({ ticketId, userId, type, data, ...(at ? { createdAt: at } : {}) });
}

async function ticketVars(db: Tx, t: TicketRow, actorId: number | null) {
  const [co] = await db.select({ name: s.companies.name }).from(s.companies).where(eq(s.companies.id, t.companyId));
  const [actor] = actorId ? await db.select({ f: s.users.firstName, l: s.users.lastName }).from(s.users).where(eq(s.users.id, actorId)) : [];
  return {
    ticket: { number: t.ticketNumber, title: t.title, company: co?.name ?? '' },
    actor: { name: actor ? `${actor.f} ${actor.l}` : 'Automation' },
  };
}

export async function createTicket(ctx: TicketCtx, raw: TicketInput | ParsedTicket): Promise<TicketRow> {
  const input = ticketSchema.parse(raw);
  const db = ctx.db;
  const now = ctx.now ?? new Date();
  await validateRefs(db, input);

  const settings = await getSystemSettings(db);
  const statusId =
    input.statusId ??
    (
      await db
        .select({ id: s.ticketStatuses.id })
        .from(s.ticketStatuses)
        .where(and(eq(s.ticketStatuses.isActive, true)))
        .orderBy(sql`${s.ticketStatuses.isDefault} desc`, sql`(${s.ticketStatuses.category} = 'new') desc`, asc(s.ticketStatuses.sortOrder))
        .limit(1)
    )[0]?.id;
  const priorityId =
    input.priorityId ??
    (
      await db
        .select({ id: s.ticketPriorities.id })
        .from(s.ticketPriorities)
        .where(eq(s.ticketPriorities.isActive, true))
        .orderBy(sql`${s.ticketPriorities.isDefault} desc`, asc(s.ticketPriorities.level))
        .limit(1)
    )[0]?.id;
  if (!statusId || !priorityId) throw badRequest('Ticket statuses/priorities are not configured');
  const status = await statusById(db, statusId);

  let queueId = input.queueId;
  if (!queueId && input.subIssueTypeId) {
    const [sub] = await db.select({ q: s.subIssueTypes.queueId }).from(s.subIssueTypes).where(eq(s.subIssueTypes.id, input.subIssueTypeId));
    queueId = sub?.q ?? null;
  }
  let assignedUserId = input.assignedUserId;
  if (!assignedUserId && queueId) {
    const [q] = await db.select({ a: s.queues.defaultAssigneeId }).from(s.queues).where(eq(s.queues.id, queueId));
    assignedUserId = q?.a ?? null;
  }

  const contractId = input.contractId ?? (await defaultContractId(db, input.companyId));
  const slaId = await resolveSlaId(db, { slaId: input.slaId, contractId, companyId: input.companyId });
  const dues = await computeDueDates(db, { slaId, priorityId, createdAt: now, slaPausedMinutes: 0 });
  const customFields = await validateCustomFields(db, 'ticket', input.customFields);
  const seq = await nextSequence(db, 'ticket');

  const terminal = status.category === 'resolved' || status.category === 'closed';
  const [ticket] = await db
    .insert(s.tickets)
    .values({
      ...input,
      ticketNumber: formatNumber(settings.ticketPrefix, seq),
      statusId,
      priorityId,
      queueId,
      assignedUserId,
      contractId,
      slaId,
      customFields,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      firstResponseDueAt: dues.firstResponseDueAt,
      resolutionDueAt: dues.resolutionDueAt,
      slaPausedAt: status.pausesSla ? now : null,
      resolvedAt: terminal ? now : null,
      closedAt: status.category === 'closed' ? now : null,
      firstResponseAt: status.category !== 'new' ? now : null,
      statusChangedAt: now,
      lastActivityAt: now,
      createdById: ctx.userId,
      createdAt: now,
    })
    .returning();

  await event(db, ticket!.id, ctx.userId, 'created', { ...origin(ctx), automation: !!ctx.automation }, now);
  if (ticket!.assignedUserId) {
    await notifyFromTemplate(
      db,
      'ticket.assigned',
      [ticket!.assignedUserId],
      await ticketVars(db, ticket!, ctx.userId),
      { type: 'ticket.assigned', title: `Ticket ${ticket!.ticketNumber} assigned to you`, body: ticket!.title, link: `/tickets/${ticket!.id}`, entityType: 'ticket', entityId: ticket!.id },
      ctx.userId,
    );
  }
  return ticket!;
}

export async function getTicketRow(db: Tx, id: number): Promise<TicketRow> {
  const [t] = await db.select().from(s.tickets).where(eq(s.tickets.id, id));
  if (!t) throw notFound('Ticket');
  return t;
}

/**
 * Applies a partial update with full lifecycle handling: SLA pause/resume,
 * first response, resolve/close/reopen timestamps, due-date recalculation,
 * change events and assignment notifications.
 */
export async function updateTicket(
  ctx: TicketCtx,
  id: number,
  patch: Partial<ParsedTicket>,
): Promise<{ ticket: TicketRow; changed: string[] }> {
  const db = ctx.db;
  const now = ctx.now ?? new Date();
  const before = await getTicketRow(db, id);

  const merged = { ...before, ...patch } as TicketRow & Partial<ParsedTicket>;
  const refsChanged = ['companyId', 'contactId', 'locationId', 'configurationItemId', 'contractId', 'projectId', 'subIssueTypeId', 'issueTypeId'].some(
    (k) => k in patch,
  );
  if (refsChanged) {
    await validateRefs(db, {
      companyId: merged.companyId,
      contactId: merged.contactId,
      locationId: merged.locationId,
      configurationItemId: merged.configurationItemId,
      contractId: merged.contractId,
      projectId: merged.projectId,
      subIssueTypeId: merged.subIssueTypeId,
      issueTypeId: merged.issueTypeId,
    });
  }

  const data: Partial<TicketRow> = {};
  for (const key of TRACKED) {
    if (!(key in patch)) continue;
    let value = (patch as Record<string, unknown>)[key];
    if (key === 'dueAt') value = value ? new Date(String(value)) : null;
    if (key === 'customFields') value = await validateCustomFields(db, 'ticket', value as Record<string, unknown>, before.customFields);
    (data as Record<string, unknown>)[key] = value;
  }
  if ('statusId' in data && data.statusId == null) delete data.statusId;
  if ('priorityId' in data && data.priorityId == null) delete data.priorityId;

  const changed = Object.keys(data).filter(
    (k) => JSON.stringify((before as Record<string, unknown>)[k] ?? null) !== JSON.stringify(normalise((data as Record<string, unknown>)[k])),
  );
  if (!changed.length) return { ticket: before, changed: [] };

  let pausedMinutes = before.slaPausedMinutes;
  if (changed.includes('statusId')) {
    const [oldSt, newSt] = await Promise.all([statusById(db, before.statusId), statusById(db, data.statusId!)]);
    data.statusChangedAt = now;
    const wasTerminal = oldSt.category === 'resolved' || oldSt.category === 'closed';
    const isTerminal = newSt.category === 'resolved' || newSt.category === 'closed';
    // Any move away from "new" counts as first response if none was recorded yet.
    if (newSt.category !== 'new' && !before.firstResponseAt) data.firstResponseAt = now;
    if (isTerminal && !before.resolvedAt) data.resolvedAt = now;
    if (newSt.category === 'closed' && !before.closedAt) data.closedAt = now;
    if (newSt.category === 'resolved' && before.closedAt) data.closedAt = null;
    if (wasTerminal && !isTerminal) {
      data.resolvedAt = null;
      data.closedAt = null;
      data.resolutionBreached = false;
      await event(db, id, ctx.userId, 'reopened', { ...origin(ctx), from: oldSt.name, to: newSt.name }, now);
    }
    // SLA pause / resume.
    if (newSt.pausesSla && !before.slaPausedAt) data.slaPausedAt = now;
    if (!newSt.pausesSla && before.slaPausedAt) {
      pausedMinutes += await pausedBusinessMinutes(db, merged.slaId ?? null, before.slaPausedAt, now);
      data.slaPausedMinutes = pausedMinutes;
      data.slaPausedAt = null;
    }
    await event(db, id, ctx.userId, isTerminal && !wasTerminal ? 'resolved' : 'status_changed', { ...origin(ctx), 
      from: oldSt.name,
      to: newSt.name,
      fromId: oldSt.id,
      toId: newSt.id,
      automation: !!ctx.automation,
    }, now);
  }

  if (changed.includes('contractId') && !('slaId' in patch)) {
    data.slaId = await resolveSlaId(db, { slaId: null, contractId: data.contractId ?? null, companyId: merged.companyId });
    if (data.slaId !== before.slaId) changed.push('slaId');
  }
  if (changed.includes('slaId') && data.slaId === null) {
    data.slaId = await resolveSlaId(db, { slaId: null, contractId: merged.contractId ?? null, companyId: merged.companyId });
  }
  if (changed.includes('priorityId') || changed.includes('slaId') || 'slaPausedMinutes' in data) {
    const dues = await computeDueDates(db, {
      slaId: (data.slaId ?? before.slaId) ?? null,
      priorityId: data.priorityId ?? before.priorityId,
      createdAt: before.createdAt,
      slaPausedMinutes: pausedMinutes,
    });
    data.firstResponseDueAt = dues.firstResponseDueAt;
    data.resolutionDueAt = dues.resolutionDueAt;
    if (changed.includes('priorityId') || changed.includes('slaId')) {
      data.firstResponseBreached = false;
      data.resolutionBreached = false;
    }
  }

  // Record breaches detected at the moment of response/resolution.
  const frAt = data.firstResponseAt ?? before.firstResponseAt;
  const frDue = data.firstResponseDueAt !== undefined ? data.firstResponseDueAt : before.firstResponseDueAt;
  if (frAt && frDue && frAt > frDue) data.firstResponseBreached = true;
  const resAt = data.resolvedAt !== undefined ? data.resolvedAt : before.resolvedAt;
  const resDue = data.resolutionDueAt !== undefined ? data.resolutionDueAt : before.resolutionDueAt;
  if (resAt && resDue && resAt > resDue) data.resolutionBreached = true;

  data.lastActivityAt = now;
  const [ticket] = await db.update(s.tickets).set(data).where(eq(s.tickets.id, id)).returning();

  for (const key of changed) {
    if (key === 'statusId') continue;
    if (key === 'assignedUserId') {
      await event(db, id, ctx.userId, 'assigned', { ...origin(ctx), from: before.assignedUserId, to: data.assignedUserId, automation: !!ctx.automation }, now);
    } else if (key === 'description' || key === 'customFields') {
      await event(db, id, ctx.userId, 'field_changed', { ...origin(ctx), field: key }, now);
    } else {
      await event(db, id, ctx.userId, 'field_changed', { ...origin(ctx), 
        field: key,
        from: (before as Record<string, unknown>)[key] ?? null,
        to: normalise((data as Record<string, unknown>)[key]),
        automation: !!ctx.automation,
      }, now);
    }
  }

  if (changed.includes('assignedUserId') && ticket!.assignedUserId) {
    await notifyFromTemplate(
      db,
      'ticket.assigned',
      [ticket!.assignedUserId],
      await ticketVars(db, ticket!, ctx.userId),
      { type: 'ticket.assigned', title: `Ticket ${ticket!.ticketNumber} assigned to you`, body: ticket!.title, link: `/tickets/${id}`, entityType: 'ticket', entityId: id },
      ctx.userId,
    );
  }
  return { ticket: ticket!, changed };
}

function normalise(v: unknown) {
  if (v instanceof Date) return v.toISOString();
  return v === undefined ? null : v;
}

export async function addTicketNote(
  ctx: TicketCtx,
  ticketId: number,
  input: { body: string; visibility: 'internal' | 'public'; statusId?: number | null; kind?: string },
) {
  const db = ctx.db;
  const now = ctx.now ?? new Date();
  const ticket = await getTicketRow(db, ticketId);
  const [note] = await db
    .insert(s.ticketNotes)
    .values({ ticketId, userId: ctx.userId, body: input.body, visibility: input.visibility, kind: input.kind ?? 'note', createdAt: now })
    .returning();
  await event(db, ticketId, ctx.userId, 'note_added', { ...origin(ctx), noteId: note!.id, visibility: input.visibility }, now);

  // A customer-visible note from a technician is a first response.
  if (input.visibility === 'public' && !ticket.firstResponseAt && ctx.userId) {
    const breached = !!ticket.firstResponseDueAt && now > ticket.firstResponseDueAt;
    await db.update(s.tickets).set({ firstResponseAt: now, firstResponseBreached: breached || ticket.firstResponseBreached }).where(eq(s.tickets.id, ticketId));
  }
  if (input.statusId && input.statusId !== ticket.statusId) {
    await updateTicket(ctx, ticketId, { statusId: input.statusId });
  } else {
    await db.update(s.tickets).set({ lastActivityAt: now }).where(eq(s.tickets.id, ticketId));
  }

  const watchers = await db.select({ userId: s.ticketWatchers.userId }).from(s.ticketWatchers).where(eq(s.ticketWatchers.ticketId, ticketId));
  await notifyFromTemplate(
    db,
    'ticket.note_added',
    [ticket.assignedUserId, ...watchers.map((w) => w.userId)],
    await ticketVars(db, ticket, ctx.userId),
    { type: 'ticket.note_added', title: `New note on ${ticket.ticketNumber}`, body: input.body.slice(0, 200), link: `/tickets/${ticketId}`, entityType: 'ticket', entityId: ticketId },
    ctx.userId,
  );
  return note!;
}

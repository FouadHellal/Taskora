import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { getSystemSettings } from '../../lib/settings.js';
import { coverageMode, loadContractTerms, localDate, recomputeCoverage, resolveRate } from '../contracts/coverage.js';

export interface TimeContext {
  companyId: number;
  projectId: number | null;
  contractId: number | null;
}

/** Derives company/project/contract from the ticket or project task the entry is logged against. */
export async function resolveTimeContext(db: Tx, ticketId: number | null, projectTaskId: number | null): Promise<TimeContext> {
  if (ticketId) {
    const [t] = await db
      .select({ companyId: s.tickets.companyId, projectId: s.tickets.projectId, contractId: s.tickets.contractId })
      .from(s.tickets)
      .where(eq(s.tickets.id, ticketId));
    if (!t) throw badRequest('Unknown ticket', { fields: { ticketId: 'Unknown ticket' } });
    return t;
  }
  if (projectTaskId) {
    const [t] = await db
      .select({ companyId: s.projects.companyId, projectId: s.projects.id, contractId: s.projects.contractId })
      .from(s.projectTasks)
      .innerJoin(s.projects, eq(s.projects.id, s.projectTasks.projectId))
      .where(eq(s.projectTasks.id, projectTaskId));
    if (!t) throw badRequest('Unknown project task', { fields: { projectTaskId: 'Unknown task' } });
    return t;
  }
  throw badRequest('Link the entry to a ticket or a project task');
}

/**
 * Billing classification of a single entry before it is stored: billable
 * flag, hourly rate (contract work-type rate → contract hourly rate → work
 * type default, overage rate on block contracts) and a preliminary coverage.
 * Block coverage depends on the other entries of the contract, so callers run
 * `recomputeCoverage` for the contract after writing the entry.
 */
export async function classifyTime(
  db: Tx,
  contractId: number | null,
  workTypeId: number | null,
  billableRequested: boolean | undefined,
  at: { startedAt?: Date; durationMinutes?: number } = {},
): Promise<{ billable: boolean; contractCovered: boolean; coveredMinutes: number; hourlyRate: number | null }> {
  let workType: typeof s.workTypes.$inferSelect | undefined;
  if (workTypeId) {
    [workType] = await db.select().from(s.workTypes).where(eq(s.workTypes.id, workTypeId));
    if (!workType) throw badRequest('Unknown work type', { fields: { workTypeId: 'Unknown work type' } });
  }
  const billable = billableRequested ?? workType?.isBillable ?? true;
  const terms = contractId ? (await loadContractTerms(db, [contractId])).get(contractId) : undefined;
  const tz = (await getSystemSettings(db)).timezone;
  const facts = { date: localDate(at.startedAt ?? new Date(), tz), billable, workTypeId };
  const mode = coverageMode(terms, facts);
  const minutes = at.durationMinutes ?? 0;
  const covered = mode === 'full' ? minutes : 0;
  return {
    billable,
    contractCovered: mode === 'full',
    coveredMinutes: covered,
    hourlyRate: resolveRate(terms, workType?.hourlyRate ?? null, facts),
  };
}

/** Rejects a contract that belongs to another company than the work it covers. */
export async function assertContractCompany(db: Tx, contractId: number | null | undefined, companyId: number) {
  if (!contractId) return;
  const [c] = await db.select({ companyId: s.contracts.companyId }).from(s.contracts).where(eq(s.contracts.id, contractId));
  if (!c) throw badRequest('Unknown contract', { fields: { contractId: 'Unknown contract' } });
  if (c.companyId !== companyId) throw badRequest('The contract belongs to another company', { fields: { contractId: 'Contract belongs to another company' } });
}

export function roundMinutes(minutes: number, increment: number): number {
  if (increment <= 1) return Math.max(1, Math.round(minutes));
  return Math.max(increment, Math.ceil(minutes / increment) * increment);
}

/** 409 for records reserved by an invoice: they must be taken off the invoice first. */
export async function invoiceLock(db: Tx, invoiceId: number, what: string) {
  const [inv] = await db.select({ number: s.invoices.invoiceNumber, status: s.invoices.status }).from(s.invoices).where(eq(s.invoices.id, invoiceId));
  const label = inv ? `${inv.status} invoice ${inv.number}` : 'an invoice';
  return conflict(`This ${what} is on ${label} — remove it from the invoice first`);
}

/**
 * When a ticket moves to another contract, its unbilled time that followed the
 * old contract moves along and is reclassified (coverage, rates).
 */
export async function reassignTicketTime(db: Tx, ticketId: number, fromContractId: number | null, toContractId: number | null) {
  const moved = await db
    .update(s.timeEntries)
    .set({ contractId: toContractId })
    .where(
      and(
        eq(s.timeEntries.ticketId, ticketId),
        isNull(s.timeEntries.invoiceId),
        ne(s.timeEntries.status, 'billed'),
        fromContractId ? eq(s.timeEntries.contractId, fromContractId) : isNull(s.timeEntries.contractId),
      ),
    )
    .returning({ id: s.timeEntries.id, workTypeId: s.timeEntries.workTypeId, billable: s.timeEntries.billable });
  if (!moved.length) return;
  if (!toContractId) {
    // No contract any more: nothing is covered, work type rates apply.
    for (const e of moved) {
      const [wt] = e.workTypeId ? await db.select({ rate: s.workTypes.hourlyRate }).from(s.workTypes).where(eq(s.workTypes.id, e.workTypeId)) : [];
      await db
        .update(s.timeEntries)
        .set({ contractCovered: false, coveredMinutes: 0, hourlyRate: e.billable ? (wt?.rate ?? null) : null })
        .where(eq(s.timeEntries.id, e.id));
    }
  }
  await recomputeCoverage(db, [fromContractId, toContractId]);
}

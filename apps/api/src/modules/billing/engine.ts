import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { computeCoverage, storedCoveredMinutes } from '../contracts/coverage.js';

/*
 * Invoice draft building, split in two:
 *  - `gatherBillingInputs` reads everything that could be billed for a
 *    company and period (no writes);
 *  - `buildDraftLines` is a pure function turning those inputs into lines.
 * The billing preview and the draft creation both use the pair, so what the
 * preview shows is exactly what a draft would contain.
 */

export const round2 = (n: number) => Math.round(n * 100) / 100;

export interface DraftOptions {
  companyId: number;
  periodStart: string;
  periodEnd: string;
  includeTime: boolean;
  includeExpenses: boolean;
  includeRecurring: boolean;
}

export interface DraftLine {
  kind: 'service' | 'fixed' | 'block' | 'ticket' | 'time' | 'expense';
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  timeEntryId?: number | null;
  expenseId?: number | null;
  contractServiceId?: number | null;
  contractId?: number | null;
  servicePeriodStart?: string | null;
  contractBlockId?: number | null;
  ticketId?: number | null;
  sortOrder: number;
}

export interface ContractInput {
  id: number;
  contractNumber: string;
  name: string;
  type: string;
  status: string;
  startDate: string;
  endDate: string | null;
  fixedAmount: number | null;
  recurringAmount: number | null;
  billingPeriod: string;
  perTicketRate: number | null;
  services: { id: number; name: string; period: string; quantity: number; unitPrice: number; startDate: string | null; endDate: string | null }[];
  blocks: { id: number; hours: number; amount: number | null; startDate: string; endDate: string | null; isPaid: boolean }[];
  /** Tickets of a per-ticket contract resolved in the period. */
  resolvedTickets: { id: number; ticketNumber: string; title: string; resolvedOn: string }[];
}

export interface TimeInput {
  id: number;
  date: string;
  description: string;
  durationMinutes: number;
  coveredMinutes: number;
  hourlyRate: number | null;
  ref: string;
  workType: string | null;
  contractNumber: string | null;
}

export interface ExpenseInput {
  id: number;
  expenseDate: string;
  description: string;
  amount: number;
}

export interface BillingInputs {
  contracts: ContractInput[];
  /** Keys (see `lineKey`) of contract lines already on non-void invoices. */
  billedKeys: Set<string>;
  /** Periods of non-void invoices carrying pre-0010 contract lines (matched by "[CTR-…]" description), per contract. */
  legacyRanges: Map<number, [string, string][]>;
  time: TimeInput[];
  expenses: ExpenseInput[];
}

/** Identity of a contract line, used to never bill the same fee/period/block/ticket twice. */
export function lineKey(l: { kind: string; contractId?: number | null; contractServiceId?: number | null; servicePeriodStart?: string | null; contractBlockId?: number | null; ticketId?: number | null }): string | null {
  if (l.contractBlockId) return `block:${l.contractBlockId}`;
  if (l.kind === 'ticket' && l.ticketId && l.contractId) return `ticket:${l.contractId}:${l.ticketId}`;
  if (l.kind === 'fixed' && l.contractId) return `fixed:${l.contractId}`;
  if (l.contractServiceId && l.servicePeriodStart) return `svc:${l.contractServiceId}:${l.servicePeriodStart}`;
  if (l.contractId && l.servicePeriodStart) return `fee:${l.contractId}:${l.servicePeriodStart}`;
  return null;
}

/* ----------------------------------------------------------- date helpers */

const PERIOD_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };

const parse = (d: string) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return { y, m, day };
};
const fmt = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Adds months to an anchor date, clamping the day to the month's length (Jan 31 + 1 → Feb 28). */
export function addMonths(date: string, n: number): string {
  const { y, m, day } = parse(date);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return fmt(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}
export function addDays(date: string, n: number): string {
  const { y, m, day } = parse(date);
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
}
/** Inclusive number of days between two dates. */
export function dayCount(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000) + 1;
}
const maxDate = (a: string, b: string | null | undefined) => (b && b > a ? b : a);
const minDate = (a: string | null | undefined, b: string | null | undefined) => (!a ? (b ?? null) : !b ? a : a < b ? a : b);

export interface BillingPeriod {
  periodStart: string;
  periodEnd: string;
  /** Billed slice of the period (contract/service window applied). */
  from: string;
  to: string;
  /** Share of the period billed (1 = full period). */
  fraction: number;
}

/**
 * Billing periods anchored on `anchor` (the contract start) whose billed slice
 * starts inside [invStart, invEnd]. Fees are billed in advance, once per
 * period; partial first/last periods are prorated by days.
 */
export function billingPeriods(anchor: string, frequency: string, itemStart: string, itemEnd: string | null, invStart: string, invEnd: string): BillingPeriod[] {
  const out: BillingPeriod[] = [];
  if (frequency === 'one_time' || !PERIOD_MONTHS[frequency]) {
    const from = maxDate(anchor, itemStart);
    if (from >= invStart && from <= invEnd && (!itemEnd || from <= itemEnd)) out.push({ periodStart: from, periodEnd: from, from, to: from, fraction: 1 });
    return out;
  }
  const months = PERIOD_MONTHS[frequency]!;
  for (let k = 0; k < 5000; k++) {
    const ps = addMonths(anchor, k * months);
    if (ps > invEnd || (itemEnd && ps > itemEnd)) break;
    const pe = addDays(addMonths(anchor, (k + 1) * months), -1);
    const from = maxDate(ps, itemStart);
    const to = minDate(pe, itemEnd)!;
    if (from > to || from < invStart || from > invEnd) continue;
    out.push({ periodStart: ps, periodEnd: pe, from, to, fraction: dayCount(from, to) / dayCount(ps, pe) });
  }
  return out;
}

/* ---------------------------------------------------------------- builder */

const FREQ_LABEL: Record<string, string> = { monthly: 'monthly', quarterly: 'quarterly', semi_annual: 'semi-annual', annual: 'annual', one_time: 'one-time' };

function periodText(p: BillingPeriod) {
  const range = p.from === p.to ? p.from : `${p.from} – ${p.to}`;
  if (p.fraction >= 1) return range;
  return `${range}, prorated ${dayCount(p.from, p.to)}/${dayCount(p.periodStart, p.periodEnd)} days`;
}

/** Pure: turns billing inputs into invoice lines. */
export function buildDraftLines(inputs: BillingInputs, o: DraftOptions): { lines: DraftLine[]; timeEntryIds: number[]; expenseIds: number[] } {
  const lines: DraftLine[] = [];
  let order = 0;
  const billed = new Set(inputs.billedKeys);
  const push = (l: Omit<DraftLine, 'sortOrder'>) => {
    const key = lineKey(l);
    if (key) {
      if (billed.has(key)) return;
      billed.add(key);
    }
    lines.push({ ...l, sortOrder: order++ });
  };
  const legacyBilled = (contractId: number, date: string) => (inputs.legacyRanges.get(contractId) ?? []).some(([a, b]) => date >= a && date <= b);

  if (o.includeRecurring) {
    for (const c of inputs.contracts) {
      if (c.status !== 'active') continue;
      const tag = `[${c.contractNumber}]`;
      // Recurring contract fee.
      if (c.recurringAmount) {
        for (const p of billingPeriods(c.startDate, c.billingPeriod, c.startDate, c.endDate, o.periodStart, o.periodEnd)) {
          if (legacyBilled(c.id, p.from)) continue;
          const amount = round2(c.recurringAmount * p.fraction);
          push({ kind: 'service', description: `${tag} ${c.name} — ${FREQ_LABEL[c.billingPeriod] ?? c.billingPeriod} fee (${periodText(p)})`, quantity: 1, unitPrice: amount, amount, contractId: c.id, servicePeriodStart: p.periodStart });
        }
      }
      // Contract services, whatever the contract type.
      for (const sv of c.services) {
        const start = maxDate(c.startDate, sv.startDate);
        const end = minDate(c.endDate, sv.endDate);
        for (const p of billingPeriods(c.startDate, sv.period, start, end, o.periodStart, o.periodEnd)) {
          if (legacyBilled(c.id, p.from)) continue;
          const unitPrice = round2(sv.unitPrice * p.fraction);
          push({
            kind: 'service',
            description: `${tag} ${sv.name} (${periodText(p)})`,
            quantity: sv.quantity,
            unitPrice,
            amount: round2(sv.quantity * sv.unitPrice * p.fraction),
            contractId: c.id,
            contractServiceId: sv.id,
            servicePeriodStart: p.periodStart,
          });
        }
      }
      // Fixed price: billed once, on the draft covering the contract start.
      if (c.fixedAmount && c.startDate >= o.periodStart && c.startDate <= o.periodEnd) {
        push({ kind: 'fixed', description: `${tag} ${c.name} — fixed price`, quantity: 1, unitPrice: c.fixedAmount, amount: c.fixedAmount, contractId: c.id });
      }
      // Unpaid hour block purchases starting in the period.
      for (const b of c.blocks) {
        if (b.isPaid || !b.amount || b.startDate < o.periodStart || b.startDate > o.periodEnd) continue;
        push({
          kind: 'block',
          description: `${tag} ${c.name} — block of ${b.hours} h (${b.startDate}${b.endDate ? ` – ${b.endDate}` : ''})`,
          quantity: 1,
          unitPrice: b.amount,
          amount: b.amount,
          contractId: c.id,
          contractBlockId: b.id,
        });
      }
      // Per-ticket fee for every ticket resolved in the period.
      if (c.type === 'per_ticket' && c.perTicketRate) {
        for (const t of c.resolvedTickets) {
          push({ kind: 'ticket', description: `${tag} ${t.ticketNumber} ${t.title} — resolved ${t.resolvedOn}`.slice(0, 500), quantity: 1, unitPrice: c.perTicketRate, amount: c.perTicketRate, contractId: c.id, ticketId: t.id });
        }
      }
    }
  }

  const timeEntryIds: number[] = [];
  if (o.includeTime) {
    for (const e of inputs.time) {
      const minutes = e.durationMinutes - e.coveredMinutes;
      if (minutes <= 0) continue;
      const rate = e.hourlyRate ?? 0;
      const partial = e.coveredMinutes > 0 ? ` — overage ${round2(minutes / 60)} of ${round2(e.durationMinutes / 60)} h` : '';
      lines.push({
        kind: 'time',
        description: `${e.date} ${e.ref}${e.workType ? ` (${e.workType})` : ''}: ${e.description}${partial}`.slice(0, 500),
        quantity: round2(minutes / 60),
        unitPrice: rate,
        amount: round2((minutes * rate) / 60),
        timeEntryId: e.id,
        sortOrder: order++,
      });
      timeEntryIds.push(e.id);
    }
  }

  const expenseIds: number[] = [];
  if (o.includeExpenses) {
    for (const x of inputs.expenses) {
      lines.push({ kind: 'expense', description: `${x.expenseDate} ${x.description}`, quantity: 1, unitPrice: x.amount, amount: x.amount, expenseId: x.id, sortOrder: order++ });
      expenseIds.push(x.id);
    }
  }
  return { lines, timeEntryIds, expenseIds };
}

/* --------------------------------------------------------------- gathering */

const localDay = (col: unknown, tz: string) => sql`(${col} at time zone ${tz})::date`;

/** Reads everything billable for the company and period. Read-only. */
export async function gatherBillingInputs(db: Tx, o: DraftOptions, tz: string): Promise<BillingInputs> {
  const contracts = await db.select().from(s.contracts).where(eq(s.contracts.companyId, o.companyId)).orderBy(asc(s.contracts.contractNumber));
  const ids = contracts.map((c) => c.id);
  const [services, blocks, tickets, existing, legacy] = ids.length
    ? await Promise.all([
        db
          .select({ line: s.contractServices, name: s.services.name, period: s.services.period })
          .from(s.contractServices)
          .innerJoin(s.services, eq(s.services.id, s.contractServices.serviceId))
          .where(inArray(s.contractServices.contractId, ids))
          .orderBy(asc(s.services.name), asc(s.contractServices.id)),
        db.select().from(s.contractBlocks).where(inArray(s.contractBlocks.contractId, ids)).orderBy(asc(s.contractBlocks.startDate), asc(s.contractBlocks.id)),
        db
          .select({
            id: s.tickets.id,
            ticketNumber: s.tickets.ticketNumber,
            title: s.tickets.title,
            contractId: s.tickets.contractId,
            resolvedOn: sql<string>`to_char(${localDay(s.tickets.resolvedAt, tz)}, 'YYYY-MM-DD')`,
          })
          .from(s.tickets)
          .where(
            and(
              inArray(s.tickets.contractId, ids),
              isNotNull(s.tickets.resolvedAt),
              sql`${localDay(s.tickets.resolvedAt, tz)} between ${o.periodStart}::date and ${o.periodEnd}::date`,
            ),
          )
          .orderBy(asc(s.tickets.resolvedAt)),
        db
          .select({
            kind: s.invoiceLines.kind,
            contractId: s.invoiceLines.contractId,
            contractServiceId: s.invoiceLines.contractServiceId,
            servicePeriodStart: s.invoiceLines.servicePeriodStart,
            contractBlockId: s.invoiceLines.contractBlockId,
            ticketId: s.invoiceLines.ticketId,
          })
          .from(s.invoiceLines)
          .innerJoin(s.invoices, eq(s.invoices.id, s.invoiceLines.invoiceId))
          .where(and(ne(s.invoices.status, 'void'), inArray(s.invoiceLines.contractId, ids))),
        // Lines written before contract columns existed: matched on the "[CTR-…]" prefix.
        db
          .select({ description: s.invoiceLines.description, periodStart: s.invoices.periodStart, periodEnd: s.invoices.periodEnd })
          .from(s.invoiceLines)
          .innerJoin(s.invoices, eq(s.invoices.id, s.invoiceLines.invoiceId))
          .where(
            and(
              ne(s.invoices.status, 'void'),
              eq(s.invoices.companyId, o.companyId),
              isNull(s.invoiceLines.contractId),
              eq(s.invoiceLines.kind, 'service'),
              sql`${s.invoiceLines.description} like '[%]%'`,
              sql`${s.invoices.periodStart} <= ${o.periodEnd}::date and ${s.invoices.periodEnd} >= ${o.periodStart}::date`,
            ),
          ),
      ])
    : [[], [], [], [], []];

  const billedKeys = new Set<string>();
  for (const l of existing) {
    const k = lineKey(l);
    if (k) billedKeys.add(k);
  }
  const legacyRanges = new Map<number, [string, string][]>();
  for (const l of legacy) {
    const c = contracts.find((x) => l.description.startsWith(`[${x.contractNumber}]`));
    if (!c) continue;
    const list = legacyRanges.get(c.id) ?? [];
    list.push([l.periodStart, l.periodEnd]);
    legacyRanges.set(c.id, list);
  }

  const contractInputs: ContractInput[] = contracts.map((c) => ({
    id: c.id,
    contractNumber: c.contractNumber,
    name: c.name,
    type: c.type,
    status: c.status,
    startDate: c.startDate,
    endDate: c.endDate,
    fixedAmount: c.fixedAmount,
    recurringAmount: c.recurringAmount,
    billingPeriod: c.billingPeriod,
    perTicketRate: c.perTicketRate,
    services: services
      .filter((x) => x.line.contractId === c.id)
      .map((x) => ({ id: x.line.id, name: x.name, period: x.period, quantity: x.line.quantity, unitPrice: x.line.unitPrice, startDate: x.line.startDate, endDate: x.line.endDate })),
    blocks: blocks.filter((b) => b.contractId === c.id).map((b) => ({ id: b.id, hours: b.hours, amount: b.amount, startDate: b.startDate, endDate: b.endDate, isPaid: b.isPaid })),
    resolvedTickets: tickets.filter((t) => t.contractId === c.id).map((t) => ({ id: t.id, ticketNumber: t.ticketNumber, title: t.title, resolvedOn: t.resolvedOn })),
  }));

  const timeRows = o.includeTime
    ? await db
        .select({
          e: s.timeEntries,
          date: sql<string>`to_char(${localDay(s.timeEntries.startedAt, tz)}, 'YYYY-MM-DD')`,
          ticketNumber: s.tickets.ticketNumber,
          workType: s.workTypes.name,
          task: s.projectTasks.title,
          contractNumber: s.contracts.contractNumber,
        })
        .from(s.timeEntries)
        .leftJoin(s.tickets, eq(s.tickets.id, s.timeEntries.ticketId))
        .leftJoin(s.workTypes, eq(s.workTypes.id, s.timeEntries.workTypeId))
        .leftJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
        .leftJoin(s.contracts, eq(s.contracts.id, s.timeEntries.contractId))
        .where(
          and(
            eq(s.timeEntries.companyId, o.companyId),
            eq(s.timeEntries.billable, true),
            eq(s.timeEntries.status, 'approved'),
            isNull(s.timeEntries.invoiceId),
            sql`${localDay(s.timeEntries.startedAt, tz)} between ${o.periodStart}::date and ${o.periodEnd}::date`,
          ),
        )
        .orderBy(asc(s.timeEntries.startedAt), asc(s.timeEntries.id))
    : [];
  // Fresh coverage (block balances can change after other entries were edited).
  const coverage = (await computeCoverage(db, [...new Set(timeRows.map((r) => r.e.contractId).filter((x): x is number => !!x))], { tz })).entries;
  const time: TimeInput[] = timeRows.map(({ e, date, ticketNumber, workType, task, contractNumber }) => {
    const cov = coverage.get(e.id);
    return {
      id: e.id,
      date,
      description: e.description,
      durationMinutes: e.durationMinutes,
      coveredMinutes: cov ? cov.coveredMinutes : storedCoveredMinutes(e),
      hourlyRate: cov ? cov.hourlyRate : e.hourlyRate,
      ref: ticketNumber ?? task ?? '',
      workType,
      contractNumber,
    };
  });

  const expenses = o.includeExpenses
    ? await db
        .select({ id: s.expenses.id, expenseDate: s.expenses.expenseDate, description: s.expenses.description, amount: s.expenses.amount })
        .from(s.expenses)
        .where(
          and(
            eq(s.expenses.companyId, o.companyId),
            eq(s.expenses.billable, true),
            isNull(s.expenses.invoiceId),
            sql`${s.expenses.expenseDate} between ${o.periodStart}::date and ${o.periodEnd}::date`,
          ),
        )
        .orderBy(asc(s.expenses.expenseDate), asc(s.expenses.id))
    : [];

  return { contracts: contractInputs, billedKeys, legacyRanges, time, expenses };
}

/** Lines (sorted) plus totals for the given tax rate. */
export function summarise(lines: DraftLine[], taxRate: number) {
  const subtotal = round2(lines.reduce((a, l) => a + l.amount, 0));
  const taxAmount = round2((subtotal * taxRate) / 100);
  return { subtotal, taxRate, taxAmount, total: round2(subtotal + taxAmount) };
}


import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { zonedParts } from '../../lib/business-time.js';
import { getSystemSettings } from '../../lib/settings.js';

/*
 * Contract coverage: decides which part of each time entry is included in a
 * contract's fee and which part is billed by the hour.
 *
 *  - fixed_price / recurring / per_ticket: billable labour is fully covered.
 *  - block_hours: covered up to the hours left in the blocks valid on the
 *    entry's date, oldest block first; the rest is overage.
 *  - retainer: like block hours when the retainer has blocks, otherwise fully covered.
 *  - time_materials: never covered.
 *
 * A contract only covers time while it is in effect (status active and the
 * entry date inside its start/end dates). Work types listed as exclusions on
 * the contract always stay billable. Entries that sit on an invoice (or are
 * billed) are locked: their stored coverage is kept and still consumes block
 * hours.
 */

export const FULL_COVER_TYPES = new Set(['fixed_price', 'recurring', 'per_ticket']);
export const BLOCK_TYPES = new Set(['block_hours', 'retainer']);
/** Entry statuses that consume contract hours (draft and rejected time does not). */
export const COUNTED_STATUSES = ['submitted', 'approved', 'billed'];

export type CoverageMode = 'none' | 'full' | 'blocks';

export interface BlockTerms {
  id: number;
  hours: number;
  amount: number | null;
  startDate: string;
  endDate: string | null;
  isPaid: boolean;
}

export interface ContractTerms {
  id: number;
  companyId: number;
  type: string;
  status: string;
  startDate: string;
  endDate: string | null;
  hourlyRate: number | null;
  overageRate: number | null;
  rates: Map<number, number>;
  excluded: Set<number>;
  blocks: BlockTerms[];
}

export interface EntryFacts {
  id: number;
  /** Local (system timezone) date of the entry, YYYY-MM-DD. */
  date: string;
  minutes: number;
  billable: boolean;
  workTypeId: number | null;
  status: string;
  locked: boolean;
  /** Stored coverage (used for locked entries). */
  storedCovered: number;
}

export interface Classification {
  contractCovered: boolean;
  coveredMinutes: number;
  hourlyRate: number | null;
}

/** Local calendar date (YYYY-MM-DD) of an instant in the given timezone. */
export function localDate(d: Date, tz: string): string {
  let p: { year: number; month: number; day: number };
  try {
    p = zonedParts(d, tz);
  } catch {
    p = zonedParts(d, 'UTC');
  }
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Stored covered minutes, accounting for rows written before block accounting existed. */
export const storedCoveredMinutes = (e: { coveredMinutes: number | null; contractCovered: boolean; durationMinutes: number }) =>
  e.coveredMinutes ?? (e.contractCovered ? e.durationMinutes : 0);

/** SQL equivalent of `storedCoveredMinutes` for a time_entries alias (default: no alias). */
export const coveredMinutesSql = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return sql.raw(`coalesce(${p}covered_minutes, case when ${p}contract_covered then ${p}duration_minutes else 0 end)`);
};

export function contractInEffect(c: Pick<ContractTerms, 'status' | 'startDate' | 'endDate'>, date: string): boolean {
  return c.status === 'active' && date >= c.startDate && (!c.endDate || date <= c.endDate);
}

export function blockActiveOn(b: Pick<BlockTerms, 'startDate' | 'endDate'>, date: string): boolean {
  return date >= b.startDate && (!b.endDate || date <= b.endDate);
}

export function coverageMode(c: ContractTerms | null | undefined, e: Pick<EntryFacts, 'date' | 'billable' | 'workTypeId'>): CoverageMode {
  if (!c || !e.billable || !contractInEffect(c, e.date)) return 'none';
  if (e.workTypeId && c.excluded.has(e.workTypeId)) return 'none';
  if (FULL_COVER_TYPES.has(c.type)) return 'full';
  if (c.type === 'block_hours') return 'blocks';
  if (c.type === 'retainer') return c.blocks.length ? 'blocks' : 'full';
  return 'none';
}

/**
 * Hourly rate for the billable part of an entry: contract work-type rate →
 * contract hourly rate → work type default; block/retainer overage uses the
 * contract overage rate when set. Contracts not in effect do not apply.
 */
export function resolveRate(c: ContractTerms | null | undefined, workTypeRate: number | null, e: Pick<EntryFacts, 'date' | 'billable' | 'workTypeId'>): number | null {
  if (!e.billable) return null;
  let rate = workTypeRate;
  if (c && contractInEffect(c, e.date)) {
    if (c.hourlyRate !== null) rate = c.hourlyRate;
    if (e.workTypeId && c.rates.has(e.workTypeId)) rate = c.rates.get(e.workTypeId)!;
    if (coverageMode(c, e) === 'blocks' && c.overageRate !== null) rate = c.overageRate;
  }
  return rate;
}

export interface Allocation {
  covered: Map<number, number>;
  /** Minutes consumed per block. */
  blockUsed: Map<number, number>;
}

/**
 * Pure block allocation. `entries` must be in chronological order. Locked
 * entries keep their stored coverage and consume block capacity first-come.
 */
export function allocate(c: ContractTerms | null | undefined, entries: EntryFacts[]): Allocation {
  const covered = new Map<number, number>();
  const blockUsed = new Map<number, number>();
  const blocks = [...(c?.blocks ?? [])].sort((a, b) => (a.startDate === b.startDate ? a.id - b.id : a.startDate < b.startDate ? -1 : 1));
  const remaining = new Map(blocks.map((b) => [b.id, Math.round(b.hours * 60)]));
  for (const b of blocks) blockUsed.set(b.id, 0);
  for (const e of entries) {
    const counted = COUNTED_STATUSES.includes(e.status);
    const mode = coverageMode(c, e);
    if (mode !== 'blocks') {
      covered.set(e.id, e.locked ? e.storedCovered : counted && mode === 'full' ? e.minutes : 0);
      continue;
    }
    if (!counted && !e.locked) {
      covered.set(e.id, 0);
      continue;
    }
    const want = e.locked ? e.storedCovered : e.minutes;
    let got = 0;
    for (const b of blocks) {
      if (got >= want) break;
      if (!blockActiveOn(b, e.date)) continue;
      const left = remaining.get(b.id)!;
      if (left <= 0) continue;
      const take = Math.min(left, want - got);
      remaining.set(b.id, left - take);
      blockUsed.set(b.id, blockUsed.get(b.id)! + take);
      got += take;
    }
    covered.set(e.id, e.locked ? e.storedCovered : got);
  }
  return { covered, blockUsed };
}

/* ------------------------------------------------------------- loading */

export async function loadContractTerms(db: Tx, contractIds: number[]): Promise<Map<number, ContractTerms>> {
  const ids = [...new Set(contractIds.filter((x): x is number => !!x))];
  const out = new Map<number, ContractTerms>();
  if (!ids.length) return out;
  const [contracts, rates, exclusions, blocks] = await Promise.all([
    db.select().from(s.contracts).where(inArray(s.contracts.id, ids)),
    db.select().from(s.contractRates).where(inArray(s.contractRates.contractId, ids)),
    db.select().from(s.contractExclusions).where(inArray(s.contractExclusions.contractId, ids)),
    db.select().from(s.contractBlocks).where(inArray(s.contractBlocks.contractId, ids)).orderBy(asc(s.contractBlocks.startDate), asc(s.contractBlocks.id)),
  ]);
  for (const c of contracts) {
    out.set(c.id, {
      id: c.id,
      companyId: c.companyId,
      type: c.type,
      status: c.status,
      startDate: c.startDate,
      endDate: c.endDate,
      hourlyRate: c.hourlyRate,
      overageRate: c.overageRate,
      rates: new Map(),
      excluded: new Set(),
      blocks: [],
    });
  }
  for (const r of rates) out.get(r.contractId)?.rates.set(r.workTypeId, r.hourlyRate);
  for (const x of exclusions) out.get(x.contractId)?.excluded.add(x.workTypeId);
  for (const b of blocks) out.get(b.contractId)?.blocks.push({ id: b.id, hours: b.hours, amount: b.amount, startDate: b.startDate, endDate: b.endDate, isPaid: b.isPaid });
  return out;
}

async function workTypeRates(db: Tx): Promise<Map<number, number | null>> {
  const rows = await db.select({ id: s.workTypes.id, hourlyRate: s.workTypes.hourlyRate }).from(s.workTypes);
  return new Map(rows.map((r) => [r.id, r.hourlyRate]));
}

interface EntryRow {
  id: number;
  contractId: number | null;
  date: string;
  durationMinutes: number;
  billable: boolean;
  workTypeId: number | null;
  status: string;
  invoiceId: number | null;
  contractCovered: boolean;
  coveredMinutes: number | null;
  hourlyRate: number | null;
}

async function loadEntries(db: Tx, contractIds: number[], tz: string): Promise<EntryRow[]> {
  if (!contractIds.length) return [];
  const rows = await db
    .select({
      id: s.timeEntries.id,
      contractId: s.timeEntries.contractId,
      date: sql<string>`to_char((${s.timeEntries.startedAt} at time zone ${tz})::date, 'YYYY-MM-DD')`,
      durationMinutes: s.timeEntries.durationMinutes,
      billable: s.timeEntries.billable,
      workTypeId: s.timeEntries.workTypeId,
      status: s.timeEntries.status,
      invoiceId: s.timeEntries.invoiceId,
      contractCovered: s.timeEntries.contractCovered,
      coveredMinutes: s.timeEntries.coveredMinutes,
      hourlyRate: s.timeEntries.hourlyRate,
    })
    .from(s.timeEntries)
    .where(inArray(s.timeEntries.contractId, contractIds))
    .orderBy(asc(s.timeEntries.startedAt), asc(s.timeEntries.id));
  return rows.map((r) => ({ ...r, hourlyRate: r.hourlyRate === null ? null : Number(r.hourlyRate) }));
}

const factsOf = (r: EntryRow): EntryFacts => ({
  id: r.id,
  date: r.date,
  minutes: r.durationMinutes,
  billable: r.billable,
  workTypeId: r.workTypeId,
  status: r.status,
  locked: r.invoiceId !== null || r.status === 'billed',
  storedCovered: storedCoveredMinutes(r),
});

export interface EntryCoverage extends Classification {
  id: number;
  contractId: number;
  durationMinutes: number;
  billable: boolean;
  status: string;
  locked: boolean;
  mode: CoverageMode;
  changed: boolean;
}

export interface BlockBalance extends BlockTerms {
  usedHours: number;
  remainingHours: number;
  expired: boolean;
  active: boolean;
}

export interface ContractBalance {
  contractId: number;
  /** Minutes logged in counted statuses (submitted, approved, billed). */
  loggedMinutes: number;
  /** Minutes covered by the contract (counted statuses). */
  coveredMinutes: number;
  /** Billable minutes not covered (counted statuses). */
  uncoveredMinutes: number;
  /** Uncovered minutes on a block/retainer contract, billed at the overage rate. */
  overageMinutes: number;
  purchasedHours: number;
  /** Hours left in blocks that have not expired (future blocks included). */
  remainingHours: number;
  usedHours: number;
  lowBalance: boolean;
  blocks: BlockBalance[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Computes coverage and rates for every entry of the given contracts without
 * writing anything, plus per-contract block balances.
 */
export async function computeCoverage(db: Tx, contractIds: number[], opts: { tz?: string; today?: string } = {}) {
  const ids = [...new Set(contractIds.filter((x): x is number => !!x))];
  const tz = opts.tz ?? (await getSystemSettings(db)).timezone;
  const today = opts.today ?? localDate(new Date(), tz);
  const [terms, wtRates, rows] = await Promise.all([loadContractTerms(db, ids), workTypeRates(db), loadEntries(db, ids, tz)]);
  const entries = new Map<number, EntryCoverage>();
  const balances = new Map<number, ContractBalance>();
  for (const id of ids) {
    const c = terms.get(id);
    const own = rows.filter((r) => r.contractId === id);
    const facts = own.map(factsOf);
    const alloc = allocate(c, facts);
    let logged = 0;
    let covered = 0;
    let uncovered = 0;
    let overage = 0;
    own.forEach((r, i) => {
      const f = facts[i]!;
      const mode = coverageMode(c, f);
      const cov = alloc.covered.get(r.id) ?? 0;
      const rate = f.locked ? r.hourlyRate : resolveRate(c, r.workTypeId ? (wtRates.get(r.workTypeId) ?? null) : null, f);
      const cls: Classification = { coveredMinutes: cov, contractCovered: cov > 0 && cov >= r.durationMinutes, hourlyRate: rate };
      const changed = !f.locked && (cls.coveredMinutes !== r.coveredMinutes || cls.contractCovered !== r.contractCovered || cls.hourlyRate !== r.hourlyRate);
      entries.set(r.id, { ...cls, id: r.id, contractId: id, durationMinutes: r.durationMinutes, billable: r.billable, status: r.status, locked: f.locked, mode, changed });
      if (COUNTED_STATUSES.includes(r.status)) {
        logged += r.durationMinutes;
        covered += cov;
        if (r.billable) {
          uncovered += r.durationMinutes - cov;
          if (mode === 'blocks') overage += r.durationMinutes - cov;
        }
      }
    });
    const blocks: BlockBalance[] = (c?.blocks ?? []).map((b) => {
      const used = (alloc.blockUsed.get(b.id) ?? 0) / 60;
      const expired = !!b.endDate && b.endDate < today;
      return { ...b, usedHours: r2(used), remainingHours: r2(Math.max(0, b.hours - used)), expired, active: blockActiveOn(b, today) };
    });
    const purchased = blocks.reduce((a, b) => a + b.hours, 0);
    const remaining = blocks.filter((b) => !b.expired).reduce((a, b) => a + b.remainingHours, 0);
    const livePurchased = blocks.filter((b) => !b.expired).reduce((a, b) => a + b.hours, 0);
    balances.set(id, {
      contractId: id,
      loggedMinutes: logged,
      coveredMinutes: covered,
      uncoveredMinutes: uncovered,
      overageMinutes: overage,
      purchasedHours: r2(purchased),
      remainingHours: r2(remaining),
      usedHours: r2(covered / 60),
      lowBalance: blocks.length > 0 && (remaining < 2 || (livePurchased > 0 && remaining < livePurchased * 0.1)),
      blocks,
    });
  }
  return { entries, balances, terms };
}

/** Shared "hours used / remaining" helper for the contract list and detail pages. */
export async function contractBalances(db: Tx, contractIds: number[]): Promise<Map<number, ContractBalance>> {
  return (await computeCoverage(db, contractIds)).balances;
}

/** Recomputes and stores coverage/rates of all unlocked entries on the given contracts. */
export async function recomputeCoverage(db: Tx, contractIds: (number | null | undefined)[]): Promise<void> {
  const ids = [...new Set(contractIds.filter((x): x is number => !!x))];
  if (!ids.length) return;
  const { entries } = await computeCoverage(db, ids);
  for (const e of entries.values()) {
    if (!e.changed) continue;
    await db
      .update(s.timeEntries)
      .set({ contractCovered: e.contractCovered, coveredMinutes: e.coveredMinutes, hourlyRate: e.hourlyRate })
      .where(and(eq(s.timeEntries.id, e.id), sql`${s.timeEntries.invoiceId} is null`));
  }
}

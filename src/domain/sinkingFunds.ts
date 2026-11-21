import { addMonthsToDate, monthKey, monthsBetween } from "./money";
import type { Cents, ISODate, MonthKey } from "./types";

/**
 * Sinking funds: save monthly for non-monthly expenses so they never blow up
 * the month they land in. A fund is a virtual envelope with a ledger of
 * contributions (+) and draws (-, spending in the fund's categories).
 */

export type Recurrence = "none" | "annual" | "semiannual" | "quarterly";

export interface SinkingFund {
  id: string;
  name: string;
  categoryIds: string[];
  target: Cents;
  nextDue: ISODate;
  recurrence: Recurrence;
  /** Optional real account the cash is held in (e.g. a HYSA). */
  backingAccountId?: string | null;
}

export interface FundLedgerEntry {
  fundId: string;
  date: ISODate;
  amount: Cents; // + contribution, - draw
  kind: "contribution" | "draw" | "adjustment";
  txnId?: string;
}

const RECUR_MONTHS: Record<Recurrence, number> = { none: 0, annual: 12, semiannual: 6, quarterly: 3 };

export function fundBalance(fundId: string, ledger: FundLedgerEntry[], asOf?: ISODate): Cents {
  let b = 0;
  for (const e of ledger) if (e.fundId === fundId && (!asOf || e.date <= asOf)) b += e.amount;
  return b;
}

/** Roll a past due date forward to the next occurrence on/after `today`. */
export function advanceDue(fund: Pick<SinkingFund, "nextDue" | "recurrence">, today: ISODate): ISODate {
  const step = RECUR_MONTHS[fund.recurrence];
  let due = fund.nextDue;
  if (step === 0) return due;
  while (due < today) due = addMonthsToDate(due, step);
  return due;
}

/**
 * Monthly set-aside to be fully funded by the due date. Contributions are made
 * in each month strictly before the due month, so the cash is there when the
 * bill arrives. If the due month is now (or past) the whole shortfall is due.
 */
export function monthlySetAside(target: Cents, balance: Cents, currentMonth: MonthKey, dueDate: ISODate): Cents {
  const shortfall = Math.max(0, target - balance);
  if (shortfall === 0) return 0;
  const months = monthsBetween(currentMonth, monthKey(dueDate));
  if (months <= 0) return shortfall;
  return Math.ceil(shortfall / months);
}

export interface FundStatus {
  fund: SinkingFund;
  balance: Cents;
  due: ISODate;
  monthsLeft: number;
  setAside: Cents;
  fundedPct: number;
  /** Ideal balance today if contributions were on a straight-line schedule since the last due date. */
  onTrackBalance: Cents;
  status: "funded" | "on_track" | "behind" | "overdrawn";
}

export function fundStatus(fund: SinkingFund, ledger: FundLedgerEntry[], today: ISODate): FundStatus {
  const balance = fundBalance(fund.id, ledger, today);
  const due = advanceDue(fund, today);
  const m = monthKey(today);
  const monthsLeft = Math.max(0, monthsBetween(m, monthKey(due)));
  const setAside = monthlySetAside(fund.target, balance, m, due);
  const cycle = RECUR_MONTHS[fund.recurrence] || 12;
  const elapsed = Math.max(0, cycle - monthsLeft);
  const onTrackBalance = Math.round((fund.target * Math.min(elapsed, cycle)) / cycle);
  let status: FundStatus["status"];
  if (balance < 0) status = "overdrawn";
  else if (balance >= fund.target) status = "funded";
  else if (balance >= onTrackBalance) status = "on_track";
  else status = "behind";
  return {
    fund,
    balance,
    due,
    monthsLeft,
    setAside,
    fundedPct: fund.target > 0 ? Math.min(1, Math.max(0, balance / fund.target)) : 1,
    onTrackBalance,
    status,
  };
}

/**
 * Turn spending lines into fund draws. `spend` is positive spent amounts by
 * category for a period; each category maps to at most one fund.
 */
export function drawsFromSpending(
  funds: SinkingFund[],
  lines: Array<{ txnId: string; date: ISODate; categoryId: string | null; amount: Cents }>,
): FundLedgerEntry[] {
  const byCat = new Map<string, string>();
  for (const f of funds) for (const c of f.categoryIds) byCat.set(c, f.id);
  const out: FundLedgerEntry[] = [];
  for (const l of lines) {
    if (!l.categoryId) continue;
    const fid = byCat.get(l.categoryId);
    if (!fid) continue;
    out.push({ fundId: fid, date: l.date, amount: l.amount, kind: "draw", txnId: l.txnId });
  }
  return out;
}

/** Total of virtual envelopes vs the real cash backing them. */
export function backingCheck(
  statuses: FundStatus[],
  accountBalances: Map<string, Cents>,
): { virtualTotal: Cents; backedBy: Cents; gap: Cents } {
  const virtualTotal = statuses.reduce((s, f) => s + Math.max(0, f.balance), 0);
  const accts = new Set(statuses.map((s) => s.fund.backingAccountId).filter((x): x is string => !!x));
  let backedBy = 0;
  for (const a of accts) backedBy += accountBalances.get(a) ?? 0;
  return { virtualTotal, backedBy, gap: virtualTotal - backedBy };
}

/** Commonly forgotten irregular expenses, used by the plan wizard checklist. */
export const COMMON_IRREGULAR_EXPENSES: Array<{ name: string; recurrence: Recurrence; hint: string }> = [
  { name: "Car insurance", recurrence: "semiannual", hint: "If paid every 6 or 12 months" },
  { name: "Vehicle registration", recurrence: "annual", hint: "DMV renewal" },
  { name: "Car maintenance & tires", recurrence: "annual", hint: "Oil, tires, brakes" },
  { name: "Home maintenance", recurrence: "annual", hint: "Rule of thumb: 1% of home value per year" },
  { name: "Property tax", recurrence: "semiannual", hint: "Only if not escrowed" },
  { name: "Homeowners/renters insurance", recurrence: "annual", hint: "Only if not escrowed" },
  { name: "Holidays & gifts", recurrence: "annual", hint: "Holidays, birthdays, weddings" },
  { name: "Travel", recurrence: "annual", hint: "Vacations and visiting family" },
  { name: "Medical deductible", recurrence: "annual", hint: "Out-of-pocket max is a safer target" },
  { name: "Annual subscriptions", recurrence: "annual", hint: "Prime, Costco, software, domains" },
  { name: "Professional dues & licenses", recurrence: "annual", hint: "" },
  { name: "Pet care", recurrence: "annual", hint: "Vet, boarding" },
  { name: "Clothing", recurrence: "annual", hint: "Seasonal" },
  { name: "Tax prep / tax bill", recurrence: "annual", hint: "Especially with side income" },
];

import { addDays, addMonthsToDate, daysBetween, median } from "./money";
import { cleanPayee, merchantKey } from "./merchant";
import type { Cents, ISODate, Transaction } from "./types";

export type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "semiannual" | "annual";

const CADENCE_DAYS: Record<Cadence, [number, number, number]> = {
  // [min gap, max gap, nominal]
  weekly: [6, 8, 7],
  biweekly: [12, 16, 14],
  semimonthly: [13, 17, 15],
  monthly: [26, 35, 30],
  quarterly: [85, 97, 91],
  semiannual: [170, 195, 182],
  annual: [350, 380, 365],
};

export interface RecurringSeries {
  key: string;
  merchant: string;
  accountId: string;
  direction: "outflow" | "inflow";
  cadence: Cadence;
  typicalAmount: Cents; // signed
  lastAmount: Cents;
  lastDate: ISODate;
  nextExpected: ISODate;
  occurrences: number;
  amountVaries: boolean;
  txnIds: string[];
  categoryId: string | null;
}

export function nextDate(last: ISODate, cadence: Cadence): ISODate {
  switch (cadence) {
    case "weekly":
      return addDays(last, 7);
    case "biweekly":
      return addDays(last, 14);
    case "semimonthly":
      return addDays(last, 15);
    case "monthly":
      return addMonthsToDate(last, 1);
    case "quarterly":
      return addMonthsToDate(last, 3);
    case "semiannual":
      return addMonthsToDate(last, 6);
    case "annual":
      return addMonthsToDate(last, 12);
  }
}

function classifyGaps(gaps: number[]): Cadence | null {
  if (gaps.length === 0) return null;
  const med = median(gaps);
  for (const c of Object.keys(CADENCE_DAYS) as Cadence[]) {
    const [lo, hi] = CADENCE_DAYS[c];
    if (med < lo || med > hi) continue;
    // Most gaps should fit (allow one skipped/odd interval).
    const fit = gaps.filter((g) => g >= lo - 2 && g <= hi + 2).length;
    if (fit / gaps.length >= 0.7) return c;
  }
  return null;
}

/**
 * Detect recurring series by merchant + account + direction. Requires >= 3
 * occurrences for sub-quarterly cadences and >= 2 for quarterly or longer.
 * Amount tolerance: 10% from median (utilities and other variable bills are
 * still detected but flagged amountVaries).
 */
export function detectRecurring(txns: Transaction[], today: ISODate): RecurringSeries[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of txns) {
    if (t.isTransfer || t.isHidden || t.pending || t.amount === 0) continue;
    const m = t.merchant ?? cleanPayee(t.payeeRaw);
    const key = `${merchantKey(m)}|${t.accountId}|${t.amount < 0 ? "o" : "i"}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  const out: RecurringSeries[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    // Collapse same-day duplicates.
    const uniq = list.filter((t, i) => i === 0 || t.date !== list[i - 1]!.date);
    const gaps = uniq.slice(1).map((t, i) => daysBetween(uniq[i]!.date, t.date));
    const cadence = classifyGaps(gaps);
    if (!cadence) continue;
    const longCadence = cadence === "quarterly" || cadence === "semiannual" || cadence === "annual";
    if (uniq.length < (longCadence ? 2 : 3)) continue;
    const amounts = uniq.map((t) => t.amount);
    const med = median(amounts);
    const varies = amounts.some((a) => Math.abs(a - med) > Math.abs(med) * 0.1);
    const last = uniq[uniq.length - 1]!;
    // Stale: no occurrence within 2 cycles -> cancelled.
    const nominal = CADENCE_DAYS[cadence][2];
    if (daysBetween(last.date, today) > nominal * 2 + 5) continue;
    out.push({
      key,
      merchant: last.merchant ?? cleanPayee(last.payeeRaw),
      accountId: last.accountId,
      direction: last.amount < 0 ? "outflow" : "inflow",
      cadence,
      typicalAmount: Math.round(med),
      lastAmount: last.amount,
      lastDate: last.date,
      nextExpected: nextDate(last.date, cadence),
      occurrences: uniq.length,
      amountVaries: varies,
      txnIds: uniq.map((t) => t.id),
      categoryId: last.categoryId,
    });
  }
  return out.sort((a, b) => a.nextExpected.localeCompare(b.nextExpected));
}

export function annualize(amount: Cents, cadence: Cadence): Cents {
  const perYear: Record<Cadence, number> = {
    weekly: 52,
    biweekly: 26,
    semimonthly: 24,
    monthly: 12,
    quarterly: 4,
    semiannual: 2,
    annual: 1,
  };
  return Math.round(amount * perYear[cadence]);
}

export function monthlyEquivalent(amount: Cents, cadence: Cadence): Cents {
  return Math.round(annualize(amount, cadence) / 12);
}

/**
 * Subscription price increase: the prior charges were stable (within 2% of
 * each other) and the latest charge is higher by more than 1% and $0.50.
 * Variable bills like utilities don't trigger this because their history isn't stable.
 */
export function priceIncrease(series: RecurringSeries, txns: Transaction[]): { from: Cents; to: Cents } | null {
  const ids = series.txnIds;
  if (ids.length < 2 || series.direction !== "outflow") return null;
  const byId = new Map(txns.map((t) => [t.id, t]));
  const charges = ids.map((id) => byId.get(id)).filter((t): t is Transaction => !!t).map((t) => -t.amount);
  if (charges.length < 2) return null;
  const to = charges[charges.length - 1]!;
  const prior = charges.slice(0, -1);
  const from = prior[prior.length - 1]!;
  const priorMed = median(prior);
  if (prior.some((c) => Math.abs(c - priorMed) > priorMed * 0.02)) return null;
  if (to - from > 50 && to > from * 1.01) return { from, to };
  return null;
}

/** Expected charges that haven't arrived within their grace window. */
export function missedCharges(series: RecurringSeries[], today: ISODate, graceDays = 5): RecurringSeries[] {
  return series.filter((s) => daysBetween(s.nextExpected, today) > graceDays);
}

/** Expand a series into expected occurrences within [start, end]. */
export function occurrencesBetween(s: RecurringSeries, start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  let d = s.nextExpected;
  let guard = 0;
  while (d < start && guard++ < 1000) d = nextDate(d, s.cadence);
  while (d <= end && guard++ < 1000) {
    out.push(d);
    d = nextDate(d, s.cadence);
  }
  return out;
}

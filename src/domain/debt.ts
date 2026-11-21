import { addMonths } from "./money";
import type { Cents, MonthKey } from "./types";

export interface Debt {
  id: string;
  name: string;
  balance: Cents; // positive amount owed
  apr: number; // 0.199 = 19.9%
  minPayment: Cents;
}

/** Monthly interest on a balance (simple monthly compounding: APR/12). */
export function monthlyInterest(balance: Cents, apr: number): Cents {
  return Math.round((balance * apr) / 12);
}

/** Fixed payment that amortizes `principal` over `months` at `apr`. */
export function amortizedPayment(principal: Cents, apr: number, months: number): Cents {
  if (months <= 0) return principal;
  const r = apr / 12;
  if (r === 0) return Math.ceil(principal / months);
  return Math.round((principal * r) / (1 - Math.pow(1 + r, -months)));
}

export interface AmortRow {
  month: number;
  payment: Cents;
  interest: Cents;
  principal: Cents;
  balance: Cents;
}

export function amortizationSchedule(principal: Cents, apr: number, payment: Cents, extra = 0, maxMonths = 600): AmortRow[] {
  const rows: AmortRow[] = [];
  let bal = principal;
  for (let m = 1; bal > 0 && m <= maxMonths; m++) {
    const interest = monthlyInterest(bal, apr);
    let pay = payment + extra;
    if (pay <= interest) throw new Error("Payment does not cover interest; balance never declines.");
    pay = Math.min(pay, bal + interest);
    const principalPaid = pay - interest;
    bal -= principalPaid;
    rows.push({ month: m, payment: pay, interest, principal: principalPaid, balance: bal });
  }
  return rows;
}

export type Strategy = "avalanche" | "snowball" | "custom";

export interface PayoffResult {
  strategy: Strategy;
  months: number;
  totalInterest: Cents;
  totalPaid: Cents;
  payoffMonthByDebt: Record<string, number>;
  order: string[];
  /** Month-by-month total remaining balance. */
  timeline: Cents[];
}

function orderDebts(debts: Debt[], strategy: Strategy, customOrder?: string[]): Debt[] {
  const d = [...debts];
  if (strategy === "avalanche") d.sort((a, b) => b.apr - a.apr || a.balance - b.balance);
  else if (strategy === "snowball") d.sort((a, b) => a.balance - b.balance || b.apr - a.apr);
  else if (customOrder) d.sort((a, b) => customOrder.indexOf(a.id) - customOrder.indexOf(b.id));
  return d;
}

/**
 * Simulate paying all debts with a fixed monthly budget = sum of minimums + extra.
 * Each month: accrue interest, pay minimums on all, then throw everything left
 * at the target debt (first in priority order). Freed-up minimums roll forward
 * (the "snowball" effect applies to both strategies).
 */
export function simulatePayoff(
  debts: Debt[],
  extraMonthly: Cents,
  strategy: Strategy,
  customOrder?: string[],
  maxMonths = 600,
): PayoffResult {
  const ordered = orderDebts(debts, strategy, customOrder);
  const bal = new Map(ordered.map((d) => [d.id, d.balance]));
  const budget = ordered.reduce((s, d) => s + d.minPayment, 0) + extraMonthly;
  const payoff: Record<string, number> = {};
  const timeline: Cents[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let month = 0;
  while ([...bal.values()].some((b) => b > 0)) {
    month++;
    if (month > maxMonths) throw new Error("Debts are not paid off within the horizon; increase payments.");
    let available = budget;
    for (const d of ordered) {
      const b = bal.get(d.id)!;
      if (b <= 0) continue;
      const i = monthlyInterest(b, d.apr);
      totalInterest += i;
      bal.set(d.id, b + i);
    }
    // Minimums first.
    for (const d of ordered) {
      const b = bal.get(d.id)!;
      if (b <= 0) continue;
      const pay = Math.min(d.minPayment, b, available);
      bal.set(d.id, b - pay);
      available -= pay;
      totalPaid += pay;
    }
    // Extra to targets in order.
    for (const d of ordered) {
      if (available <= 0) break;
      const b = bal.get(d.id)!;
      if (b <= 0) continue;
      const pay = Math.min(b, available);
      bal.set(d.id, b - pay);
      available -= pay;
      totalPaid += pay;
    }
    for (const d of ordered) if (bal.get(d.id)! <= 0 && payoff[d.id] === undefined) payoff[d.id] = month;
    timeline.push([...bal.values()].reduce((s, b) => s + Math.max(0, b), 0));
  }
  return { strategy, months: month, totalInterest, totalPaid, payoffMonthByDebt: payoff, order: ordered.map((d) => d.id), timeline };
}

export function compareStrategies(debts: Debt[], extraMonthly: Cents) {
  const avalanche = simulatePayoff(debts, extraMonthly, "avalanche");
  const snowball = simulatePayoff(debts, extraMonthly, "snowball");
  const minimumsOnly = simulatePayoff(debts, 0, "avalanche");
  return {
    avalanche,
    snowball,
    minimumsOnly,
    interestSavedVsMinimums: minimumsOnly.totalInterest - avalanche.totalInterest,
    avalancheAdvantage: snowball.totalInterest - avalanche.totalInterest,
  };
}

export function payoffMonthLabel(start: MonthKey, monthsFromNow: number): MonthKey {
  return addMonths(start, monthsFromNow - 1);
}

/** Credit utilization per card and overall. Balances are owed amounts (positive). */
export function utilization(cards: Array<{ id: string; owed: Cents; limit: Cents | null | undefined }>) {
  const per = cards
    .filter((c) => c.limit && c.limit > 0)
    .map((c) => ({ id: c.id, ratio: Math.max(0, c.owed) / c.limit! }));
  const totalOwed = cards.filter((c) => c.limit).reduce((s, c) => s + Math.max(0, c.owed), 0);
  const totalLimit = cards.reduce((s, c) => s + (c.limit ?? 0), 0);
  return { perCard: per, overall: totalLimit > 0 ? totalOwed / totalLimit : null };
}

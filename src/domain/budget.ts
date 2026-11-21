import { daysInMonth, monthKey } from "./money";
import type { ClassifiedLine } from "./ledger";
import type { Category, Cents, ISODate, MonthKey } from "./types";

/**
 * Flex budgeting. A month's plan is:
 *
 *   expected income
 * - fixed costs (bills, minimum payments, subscriptions)
 * - sinking fund set-asides (non-monthly expenses)
 * - savings goals
 * = flex spending available (one number for all day-to-day spending)
 *
 * Non-monthly spending is funded by sinking funds, so it doesn't count against flex.
 */

export interface BudgetLine {
  categoryId: string;
  amount: Cents; // planned (positive)
  rollover?: boolean;
}

export interface MonthPlan {
  month: MonthKey;
  expectedIncome: Cents;
  fixed: BudgetLine[];
  /** Total flex budget; if omitted it is derived as the remainder. */
  flexTotal?: Cents | null;
  /** Optional per-category flex targets (informational, sum can be <= flexTotal). */
  flexLines?: BudgetLine[];
  sinkingSetAside: Cents;
  savingsGoals: Cents;
  flexRollover?: boolean;
}

export interface CategoryActual {
  categoryId: string;
  budgeted: Cents;
  carryIn: Cents;
  spent: Cents; // positive = spent, negative = net refund
  remaining: Cents; // budgeted + carryIn - spent
}

export interface PaceInfo {
  daysElapsed: number;
  daysLeft: number;
  expectedSpentByNow: Cents;
  status: "under" | "on_pace" | "over";
  /** Remaining flex / days left (including today). */
  perDayLeft: Cents;
  projectedMonthEnd: Cents;
}

export interface MonthBudgetResult {
  month: MonthKey;
  income: { expected: Cents; actual: Cents };
  fixed: { budgeted: Cents; spent: Cents; lines: CategoryActual[] };
  flex: {
    budgeted: Cents;
    carryIn: Cents;
    spent: Cents;
    remaining: Cents;
    lines: CategoryActual[];
    pace: PaceInfo | null;
  };
  nonMonthly: { spent: Cents; byCategory: Map<string, Cents> };
  sinkingSetAside: Cents;
  savingsGoals: Cents;
  /** Plan check: income - fixed - sinking - savings - flex. Should be >= 0. */
  unallocated: Cents;
  uncategorizedSpent: Cents;
}

export function derivedFlex(plan: MonthPlan): Cents {
  const fixed = plan.fixed.reduce((s, l) => s + l.amount, 0);
  return plan.expectedIncome - fixed - plan.sinkingSetAside - plan.savingsGoals;
}

function spendByCategory(lines: ClassifiedLine[], month: MonthKey): Map<string | null, Cents> {
  const m = new Map<string | null, Cents>();
  for (const l of lines) {
    if (l.kind !== "expense" || monthKey(l.date) !== month) continue;
    m.set(l.categoryId, (m.get(l.categoryId) ?? 0) - l.amount);
  }
  return m;
}

export function computePace(budget: Cents, spent: Cents, month: MonthKey, today: ISODate, tolerance = 0.05): PaceInfo | null {
  if (monthKey(today) !== month) return null;
  const dim = daysInMonth(month);
  const day = Number(today.slice(8, 10));
  const daysElapsed = day; // includes today
  const daysLeft = dim - day + 1;
  const expected = Math.round((budget * daysElapsed) / dim);
  const remaining = budget - spent;
  const status = spent > expected * (1 + tolerance) ? "over" : spent < expected * (1 - tolerance) ? "under" : "on_pace";
  // Linear projection from spend so far.
  const projected = daysElapsed > 0 ? Math.round((spent / daysElapsed) * dim) : spent;
  return {
    daysElapsed,
    daysLeft,
    expectedSpentByNow: expected,
    status,
    perDayLeft: daysLeft > 0 ? Math.floor(Math.max(0, remaining) / daysLeft) : 0,
    projectedMonthEnd: projected,
  };
}

export function computeMonth(
  plan: MonthPlan,
  lines: ClassifiedLine[],
  categories: Category[],
  opts: { today?: ISODate; carryIn?: Map<string, Cents>; flexCarryIn?: Cents } = {},
): MonthBudgetResult {
  const cats = new Map(categories.map((c) => [c.id, c]));
  const spend = spendByCategory(lines, plan.month);
  const income = lines
    .filter((l) => l.kind === "income" && monthKey(l.date) === plan.month)
    .reduce((s, l) => s + l.amount, 0);

  const carry = opts.carryIn ?? new Map<string, Cents>();

  const fixedLines: CategoryActual[] = plan.fixed.map((b) => {
    const spent = spend.get(b.categoryId) ?? 0;
    const carryIn = b.rollover ? carry.get(b.categoryId) ?? 0 : 0;
    return { categoryId: b.categoryId, budgeted: b.amount, carryIn, spent, remaining: b.amount + carryIn - spent };
  });
  const fixedIds = new Set(plan.fixed.map((b) => b.categoryId));

  // Spending in fixed-type categories without a budget line still counts as fixed.
  let fixedSpent = fixedLines.reduce((s, l) => s + l.spent, 0);
  let flexSpent = 0;
  let nonMonthlySpent = 0;
  let uncategorized = 0;
  const nonMonthlyBy = new Map<string, Cents>();
  const flexBy = new Map<string, Cents>();
  for (const [cid, amt] of spend) {
    if (cid === null) {
      uncategorized += amt;
      flexSpent += amt; // unknown spending is treated as flexible until categorized
      continue;
    }
    if (fixedIds.has(cid)) continue;
    const c = cats.get(cid);
    const bt = c?.budgetType ?? "flex";
    if (bt === "fixed") fixedSpent += amt;
    else if (bt === "non_monthly") {
      nonMonthlySpent += amt;
      nonMonthlyBy.set(cid, (nonMonthlyBy.get(cid) ?? 0) + amt);
    } else {
      flexSpent += amt;
      flexBy.set(cid, (flexBy.get(cid) ?? 0) + amt);
    }
  }

  const flexBudget = plan.flexTotal ?? Math.max(0, derivedFlex(plan));
  const flexCarry = plan.flexRollover ? opts.flexCarryIn ?? 0 : 0;
  const flexLines: CategoryActual[] = (plan.flexLines ?? []).map((b) => {
    const spent = flexBy.get(b.categoryId) ?? 0;
    const carryIn = b.rollover ? carry.get(b.categoryId) ?? 0 : 0;
    return { categoryId: b.categoryId, budgeted: b.amount, carryIn, spent, remaining: b.amount + carryIn - spent };
  });
  // Unbudgeted flex categories with spending, for display.
  const flexLineIds = new Set(flexLines.map((l) => l.categoryId));
  for (const [cid, amt] of flexBy) {
    if (!flexLineIds.has(cid)) flexLines.push({ categoryId: cid, budgeted: 0, carryIn: 0, spent: amt, remaining: -amt });
  }
  flexLines.sort((a, b) => b.spent - a.spent);

  const fixedBudgeted = plan.fixed.reduce((s, l) => s + l.amount, 0);
  return {
    month: plan.month,
    income: { expected: plan.expectedIncome, actual: income },
    fixed: { budgeted: fixedBudgeted, spent: fixedSpent, lines: fixedLines },
    flex: {
      budgeted: flexBudget,
      carryIn: flexCarry,
      spent: flexSpent,
      remaining: flexBudget + flexCarry - flexSpent,
      lines: flexLines,
      pace: opts.today ? computePace(flexBudget + flexCarry, flexSpent, plan.month, opts.today) : null,
    },
    nonMonthly: { spent: nonMonthlySpent, byCategory: nonMonthlyBy },
    sinkingSetAside: plan.sinkingSetAside,
    savingsGoals: plan.savingsGoals,
    unallocated: plan.expectedIncome - fixedBudgeted - plan.sinkingSetAside - plan.savingsGoals - flexBudget,
    uncategorizedSpent: uncategorized,
  };
}

/** Carry for next month from this month's result (only rollover-enabled lines). */
export function nextCarry(plan: MonthPlan, result: MonthBudgetResult): { carry: Map<string, Cents>; flexCarry: Cents } {
  const carry = new Map<string, Cents>();
  const roll = new Set([...plan.fixed, ...(plan.flexLines ?? [])].filter((l) => l.rollover).map((l) => l.categoryId));
  for (const l of [...result.fixed.lines, ...result.flex.lines]) if (roll.has(l.categoryId)) carry.set(l.categoryId, l.remaining);
  return { carry, flexCarry: plan.flexRollover ? result.flex.remaining : 0 };
}

/**
 * Plan wizard: propose a plan from trailing history.
 * - fixed: median monthly spend for fixed categories over the window
 * - flex: median monthly flex spend (a realistic starting point, not aspirational)
 * - income: 25th percentile of monthly baseline income (conservative)
 */
export function proposePlan(
  monthly: Array<{ month: MonthKey; byCategory: Map<string | null, Cents>; baselineIncome: Cents }>,
  categories: Category[],
): { expectedIncome: Cents; fixed: BudgetLine[]; flexTotal: Cents } {
  const cats = new Map(categories.map((c) => [c.id, c]));
  const fixedSeries = new Map<string, number[]>();
  const flexTotals: number[] = [];
  for (const m of monthly) {
    let flex = 0;
    const seen = new Set<string>();
    for (const [cid, spent] of m.byCategory) {
      const bt = cid ? cats.get(cid)?.budgetType : "flex";
      if (bt === "fixed" && cid) {
        seen.add(cid);
        (fixedSeries.get(cid) ?? fixedSeries.set(cid, []).get(cid)!).push(spent);
      } else if (bt === "flex" || bt === undefined) flex += spent;
    }
    for (const [cid, arr] of fixedSeries) if (!seen.has(cid)) arr.push(0);
    flexTotals.push(flex);
  }
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const n = s.length;
    return n === 0 ? 0 : n % 2 ? s[(n - 1) / 2]! : Math.round((s[n / 2 - 1]! + s[n / 2]!) / 2);
  };
  const fixed: BudgetLine[] = [];
  for (const [cid, arr] of fixedSeries) {
    const v = med(arr);
    if (v > 0) fixed.push({ categoryId: cid, amount: Math.round(v / 100) * 100 });
  }
  const incomes = monthly.map((m) => m.baselineIncome).sort((a, b) => a - b);
  const p25 = incomes.length ? incomes[Math.floor((incomes.length - 1) * 0.25)]! : 0;
  return { expectedIncome: p25, fixed, flexTotal: Math.round(med(flexTotals) / 1000) * 1000 };
}

import { addMonths, monthKey, monthsBetween } from "./money";
import type { Cents, ISODate, MonthKey } from "./types";

export type GoalType = "emergency_fund" | "savings" | "debt_payoff" | "down_payment" | "retirement" | "custom";

export interface Goal {
  id: string;
  name: string;
  type: GoalType;
  target: Cents;
  targetDate?: ISODate | null;
  priority: number;
  /** Current progress (balance of linked accounts, or allocated contributions). */
  current: Cents;
  /** Trailing monthly contributions, oldest first (for pace). */
  recentContributions?: Cents[];
}

export interface GoalStatus {
  goal: Goal;
  remaining: Cents;
  pct: number;
  pace: Cents; // avg monthly contribution over the trailing window
  requiredMonthly: Cents | null;
  eta: MonthKey | null;
  status: "complete" | "on_track" | "behind" | "no_pace" | "no_date";
  shortfallPerMonth: Cents;
}

export function goalStatus(goal: Goal, today: ISODate): GoalStatus {
  const remaining = Math.max(0, goal.target - goal.current);
  const pct = goal.target > 0 ? Math.min(1, goal.current / goal.target) : 1;
  const recent = (goal.recentContributions ?? []).slice(-3);
  const pace = recent.length ? Math.round(recent.reduce((s, x) => s + x, 0) / recent.length) : 0;
  const now = monthKey(today);
  const eta = remaining === 0 ? now : pace > 0 ? addMonths(now, Math.ceil(remaining / pace)) : null;
  let requiredMonthly: Cents | null = null;
  if (goal.targetDate) {
    const months = Math.max(1, monthsBetween(now, monthKey(goal.targetDate)));
    requiredMonthly = Math.ceil(remaining / months);
  }
  let status: GoalStatus["status"];
  if (remaining === 0) status = "complete";
  else if (requiredMonthly == null) status = pace > 0 ? "no_date" : "no_pace";
  else if (pace >= requiredMonthly) status = "on_track";
  else status = pace > 0 ? "behind" : "no_pace";
  return {
    goal,
    remaining,
    pct,
    pace,
    requiredMonthly,
    eta,
    status,
    shortfallPerMonth: requiredMonthly != null ? Math.max(0, requiredMonthly - pace) : 0,
  };
}

/** Distribute a monthly savings amount across goals in priority order (each up to its required monthly). */
export function waterfall(goals: Goal[], monthlyAmount: Cents, today: ISODate): Map<string, Cents> {
  const out = new Map<string, Cents>();
  let left = monthlyAmount;
  const sorted = [...goals].sort((a, b) => a.priority - b.priority);
  for (const g of sorted) {
    const st = goalStatus(g, today);
    const want = st.requiredMonthly ?? st.remaining;
    const give = Math.max(0, Math.min(left, want));
    out.set(g.id, give);
    left -= give;
  }
  // Anything left goes to the top-priority incomplete goal.
  if (left > 0) {
    const first = sorted.find((g) => g.current < g.target);
    if (first) out.set(first.id, (out.get(first.id) ?? 0) + left);
  }
  return out;
}

/**
 * Emergency fund target: N months of *essential* spending (fixed costs plus
 * essential flexible categories such as groceries and gas), not total spending.
 * Default N: 3 for two stable incomes, 6 for a single or variable income.
 */
export function emergencyFundTarget(monthlyEssential: Cents, opts: { dualIncome: boolean; variableIncome: boolean }): {
  months: number;
  target: Cents;
} {
  const months = opts.dualIncome && !opts.variableIncome ? 3 : 6;
  return { months, target: monthlyEssential * months };
}

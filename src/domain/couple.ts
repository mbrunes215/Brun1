import { allocate } from "./money";
import type { ClassifiedLine } from "./ledger";
import type { Cents, ISODate, Owner } from "./types";

/**
 * Couple finances: support "mostly separate" today and a deliberate path to
 * fully joint.
 *
 * Shared expense = a household cost paid from one partner's personal account
 * (flagged isShared). Each shared dollar is split by the household split policy;
 * the settle-up balance says who owes whom. Spending from joint accounts is
 * already shared money and doesn't enter the settle-up.
 */

export type SplitMode = "equal" | "income" | "custom";

export interface SplitRule {
  mode: SplitMode;
  /** Partner A's share for custom mode (0..1). */
  shareA?: number;
}

export interface SplitPolicy {
  default: SplitRule;
  byCategory?: Record<string, SplitRule>;
  /** Monthly baseline incomes used for income-proportional splits (gross or net, but consistently). */
  incomeA: Cents;
  incomeB: Cents;
  /** When true the household is fully joint: settle-up is retired. */
  fullyJoint?: boolean;
}

export function shareOfA(rule: SplitRule, policy: SplitPolicy): number {
  switch (rule.mode) {
    case "equal":
      return 0.5;
    case "custom":
      return Math.min(1, Math.max(0, rule.shareA ?? 0.5));
    case "income": {
      const total = policy.incomeA + policy.incomeB;
      return total > 0 ? policy.incomeA / total : 0.5;
    }
  }
}

export interface Settlement {
  date: ISODate;
  from: Exclude<Owner, "joint">;
  to: Exclude<Owner, "joint">;
  amount: Cents; // positive
  txnId?: string;
}

export interface SettleUpResult {
  sharedTotal: Cents;
  paidByA: Cents;
  paidByB: Cents;
  fairShareA: Cents;
  fairShareB: Cents;
  settlementsAtoB: Cents;
  settlementsBtoA: Cents;
  /** Positive: B owes A. Negative: A owes B. */
  balance: Cents;
  lines: Array<{ txnId: string; date: ISODate; paidBy: Owner; spent: Cents; shareA: Cents; shareB: Cents }>;
}

export function settleUp(
  lines: ClassifiedLine[],
  policy: SplitPolicy,
  settlements: Settlement[],
  range?: { start: ISODate; end: ISODate },
): SettleUpResult {
  let sharedTotal = 0;
  let paidByA = 0;
  let paidByB = 0;
  let fairA = 0;
  let fairB = 0;
  const out: SettleUpResult["lines"] = [];
  for (const l of lines) {
    if (!l.isShared || l.kind !== "expense" || l.owner === "joint") continue;
    if (range && (l.date < range.start || l.date > range.end)) continue;
    const spent = -l.amount; // refunds come through as negative spend
    const rule = (l.categoryId && policy.byCategory?.[l.categoryId]) || policy.default;
    const sA = shareOfA(rule, policy);
    const [a, b] = allocate(spent, [sA, 1 - sA]) as [Cents, Cents];
    sharedTotal += spent;
    if (l.owner === "A") paidByA += spent;
    else paidByB += spent;
    fairA += a;
    fairB += b;
    out.push({ txnId: l.txnId, date: l.date, paidBy: l.owner, spent, shareA: a, shareB: b });
  }
  let aToB = 0;
  let bToA = 0;
  for (const s of settlements) {
    if (range && (s.date < range.start || s.date > range.end)) continue;
    if (s.from === "A") aToB += s.amount;
    else bToA += s.amount;
  }
  // A is owed what A paid beyond A's fair share; settlements adjust.
  const balance = paidByA - fairA - bToA + aToB;
  return {
    sharedTotal,
    paidByA,
    paidByB,
    fairShareA: fairA,
    fairShareB: fairB,
    settlementsAtoB: aToB,
    settlementsBtoA: bToA,
    balance,
    lines: out,
  };
}

/** Share of household spending that flows through joint accounts. The merge-plan headline metric. */
export function jointShare(lines: ClassifiedLine[], range?: { start: ISODate; end: ISODate }): number {
  let joint = 0;
  let total = 0;
  for (const l of lines) {
    if (l.kind !== "expense") continue;
    if (range && (l.date < range.start || l.date > range.end)) continue;
    const spent = -l.amount;
    total += spent;
    if (l.owner === "joint") joint += spent;
  }
  return total > 0 ? joint / total : 0;
}

/**
 * Joint-account funding fairness: compare each partner's transfers into joint
 * accounts with their target share of what the joint accounts spent.
 */
export function jointFunding(
  contributions: Array<{ owner: Exclude<Owner, "joint">; amount: Cents }>,
  jointSpending: Cents,
  shareA: number,
): { contributedA: Cents; contributedB: Cents; targetA: Cents; targetB: Cents; diffA: Cents } {
  const contributedA = contributions.filter((c) => c.owner === "A").reduce((s, c) => s + c.amount, 0);
  const contributedB = contributions.filter((c) => c.owner === "B").reduce((s, c) => s + c.amount, 0);
  const [targetA, targetB] = allocate(jointSpending, [shareA, 1 - shareA]) as [Cents, Cents];
  return { contributedA, contributedB, targetA, targetB, diffA: contributedA - targetA };
}

export const DEFAULT_MERGE_MILESTONES: Array<{ key: string; title: string; detail: string }> = [
  { key: "values", title: "Talk through money values and goals", detail: "Agree on the top 3 goals and how decisions over a set amount get made together." },
  { key: "joint_checking", title: "Open a joint checking account", detail: "The hub for shared bills." },
  { key: "fun_money", title: "Agree on personal fun money", detail: "A no-questions monthly amount each. Keeps autonomy as everything else merges." },
  { key: "bills_to_joint", title: "Move shared bills to joint", detail: "Rent/mortgage, utilities, insurance, groceries, subscriptions." },
  { key: "paychecks", title: "Route paychecks to joint", detail: "Fully, or a fixed amount each with the rest to personal accounts." },
  { key: "emergency_fund", title: "Build a joint emergency fund", detail: "3-6 months of essential expenses in a joint HYSA." },
  { key: "joint_card", title: "Consolidate to a primary joint credit card", detail: "Add each other as authorized users or open a joint card." },
  { key: "debts", title: "Decide how to handle pre-existing debt", detail: "Shared payoff plan vs individually owned. Both are fine; be explicit." },
  { key: "beneficiaries", title: "Review beneficiaries and insurance", detail: "Retirement accounts, life insurance, wills/estate basics." },
  { key: "retire_settle_up", title: "Switch to fully joint", detail: "Settle up the last balance and retire the split." },
];

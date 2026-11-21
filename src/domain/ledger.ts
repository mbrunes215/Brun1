import { INSTALLMENT_DEBT, SAVINGS_DESTINATIONS } from "./accounts";
import { inRange, monthKey } from "./money";
import type { Account, Category, Cents, FlowKind, ISODate, MonthKey, Owner, Transaction, TransactionLine } from "./types";

/**
 * The accounting core. Every transaction line is classified into exactly one
 * flow kind so that household totals are never double counted:
 *
 * - Credit card payments: both legs are internal transfers (spend was already
 *   recognized when the card purchases posted).
 * - Transfers into savings/investment accounts: counted once as "savings", on
 *   the destination leg. Withdrawals from savings are negative savings.
 * - Payments to installment debt (mortgage, auto, student loan) that are linked
 *   to a tracked loan account: the cash leg counts as an expense in its
 *   category (it is a real monthly cost for budgeting). Principal reduction is
 *   picked up separately from loan balance changes for savings rate.
 * - Refunds: positive amounts in an expense category reduce that category.
 * - Reimbursable expenses and the reimbursements that repay them are excluded.
 * - Settle-up payments between partners are internal to the household.
 */

export interface ClassifiedLine {
  txnId: string;
  splitId?: string;
  accountId: string;
  date: ISODate;
  categoryId: string | null;
  owner: Owner;
  kind: FlowKind;
  /** Signed account-perspective amount (negative = outflow). */
  amount: Cents;
  /** For kind "savings": amount saved (positive) or withdrawn (negative). */
  saved: Cents;
  isShared: boolean;
  isPrivate: boolean;
  pending: boolean;
  tags: string[];
}

export interface LedgerContext {
  accounts: Map<string, Account>;
  categories: Map<string, Category>;
  txnsById?: Map<string, Transaction>;
}

export function makeContext(accounts: Account[], categories: Category[], txns?: Transaction[]): LedgerContext {
  return {
    accounts: new Map(accounts.map((a) => [a.id, a])),
    categories: new Map(categories.map((c) => [c.id, c])),
    txnsById: txns ? new Map(txns.map((t) => [t.id, t])) : undefined,
  };
}

export function linesOf(t: Transaction): TransactionLine[] {
  if (t.splits && t.splits.length > 0) return t.splits;
  return [{ amount: t.amount, categoryId: t.categoryId, owner: t.owner, tags: t.tags }];
}

export function splitsBalance(t: Transaction): boolean {
  if (!t.splits || t.splits.length === 0) return true;
  return t.splits.reduce((s, l) => s + l.amount, 0) === t.amount;
}

function transferKind(
  t: Transaction,
  account: Account,
  line: TransactionLine,
  ctx: LedgerContext,
): { kind: FlowKind; saved: Cents } {
  const pair = t.transferPairId ? ctx.txnsById?.get(t.transferPairId) : undefined;
  const pairAccount = pair ? ctx.accounts.get(pair.accountId) : undefined;

  // This leg sits on a savings/investment account: count it as savings.
  if (SAVINGS_DESTINATIONS.has(account.type)) {
    // Moving between two savings accounts is just a transfer.
    if (pairAccount && SAVINGS_DESTINATIONS.has(pairAccount.type)) return { kind: "transfer", saved: 0 };
    return { kind: "savings", saved: line.amount };
  }
  // Cash leg of a payment to a tracked installment loan: a real monthly cost.
  if (pairAccount && INSTALLMENT_DEBT.has(pairAccount.type) && line.amount < 0) {
    return { kind: "expense", saved: 0 };
  }
  // Unpaired leg whose other side is untracked: fall back to the category.
  if (!pairAccount && line.categoryId) {
    const cat = ctx.categories.get(line.categoryId);
    if (cat?.budgetType === "savings") return { kind: "savings", saved: -line.amount };
  }
  return { kind: "transfer", saved: 0 };
}

export function classifyTransaction(t: Transaction, ctx: LedgerContext): ClassifiedLine[] {
  const account = ctx.accounts.get(t.accountId);
  if (!account) throw new Error(`Unknown account ${t.accountId} for txn ${t.id}`);

  return linesOf(t).map((line) => {
    const owner: Owner = line.owner ?? t.owner ?? account.owner;
    const cat = line.categoryId ? ctx.categories.get(line.categoryId) : undefined;
    const base = {
      txnId: t.id,
      splitId: line.splitId,
      accountId: t.accountId,
      date: t.date,
      categoryId: line.categoryId,
      owner,
      amount: line.amount,
      isShared: !!t.isShared,
      isPrivate: !!t.isPrivate || !!cat?.isPersonalAllowance,
      pending: !!t.pending,
      tags: line.tags ?? t.tags ?? [],
    };

    let kind: FlowKind;
    let saved = 0;

    if (t.isHidden || account.excludeFromCashFlow) kind = "ignored";
    else if (t.isSettlement) kind = "transfer";
    else if (t.isReimbursable || t.reimbursementOfId) kind = "reimbursable";
    else if (t.isTransfer || cat?.isTransferLike || cat?.budgetType === "transfer") {
      ({ kind, saved } = transferKind(t, account, line, ctx));
    } else if (!cat) {
      kind = line.amount < 0 ? "expense" : "income";
    } else if (cat.budgetType === "income") kind = "income";
    else if (cat.budgetType === "savings") {
      kind = "savings";
      // Money leaving a spending account into a "savings" category = saved.
      saved = SAVINGS_DESTINATIONS.has(account.type) ? line.amount : -line.amount;
    } else kind = "expense";

    return { ...base, kind, saved };
  });
}

export function classifyAll(txns: Transaction[], ctx: LedgerContext): ClassifiedLine[] {
  const c = ctx.txnsById ? ctx : { ...ctx, txnsById: new Map(txns.map((t) => [t.id, t])) };
  return txns.flatMap((t) => classifyTransaction(t, c));
}

// ---------------- Aggregation ----------------

export type OwnerFilter = "household" | Owner;

export function ownerMatches(line: ClassifiedLine, f: OwnerFilter): boolean {
  return f === "household" || line.owner === f;
}

export interface CashFlowSummary {
  income: Cents;
  /** Positive number: total net spending (purchases minus refunds). */
  spending: Cents;
  /** Net amount moved into savings/investments. */
  saved: Cents;
  /** income - spending. What was available to save. */
  net: Cents;
  byCategory: Map<string | null, Cents>; // net signed amount per category (expenses negative)
}

export function summarize(
  lines: ClassifiedLine[],
  opts: { start?: ISODate; end?: ISODate; owner?: OwnerFilter } = {},
): CashFlowSummary {
  let income = 0;
  let expense = 0;
  let saved = 0;
  const byCategory = new Map<string | null, Cents>();
  for (const l of lines) {
    if (opts.start && opts.end && !inRange(l.date, opts.start, opts.end)) continue;
    if (opts.owner && !ownerMatches(l, opts.owner)) continue;
    if (l.kind === "income") income += l.amount;
    else if (l.kind === "expense") expense += l.amount;
    else if (l.kind === "savings") saved += l.saved;
    else continue;
    if (l.kind !== "savings") byCategory.set(l.categoryId, (byCategory.get(l.categoryId) ?? 0) + l.amount);
  }
  return { income, spending: expense === 0 ? 0 : -expense, saved, net: income + expense, byCategory };
}

export function spendingByMonth(lines: ClassifiedLine[]): Map<MonthKey, CashFlowSummary> {
  const groups = new Map<MonthKey, ClassifiedLine[]>();
  for (const l of lines) {
    const m = monthKey(l.date);
    const arr = groups.get(m);
    if (arr) arr.push(l);
    else groups.set(m, [l]);
  }
  const out = new Map<MonthKey, CashFlowSummary>();
  for (const [m, ls] of [...groups.entries()].sort()) out.set(m, summarize(ls));
  return out;
}

/** Net spend per category for a set of lines (positive = spent). */
export function categorySpend(lines: ClassifiedLine[]): Map<string | null, Cents> {
  const out = new Map<string | null, Cents>();
  for (const l of lines) {
    if (l.kind !== "expense") continue;
    out.set(l.categoryId, (out.get(l.categoryId) ?? 0) - l.amount);
  }
  return out;
}

/** Redact private (personal allowance) lines for a viewer who is not the owner. */
export function redactForViewer<T extends { owner: Owner; isPrivate: boolean }>(
  items: T[],
  viewer: Owner,
): { visible: T[]; hiddenTotalByOwner: Map<Owner, number> } {
  const visible: T[] = [];
  const hidden = new Map<Owner, number>();
  for (const it of items) {
    if (it.isPrivate && it.owner !== viewer && it.owner !== "joint") {
      hidden.set(it.owner, (hidden.get(it.owner) ?? 0) + ((it as unknown as { amount?: number }).amount ?? 0));
    } else visible.push(it);
  }
  return { visible, hiddenTotalByOwner: hidden };
}

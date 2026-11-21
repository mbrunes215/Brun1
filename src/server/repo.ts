import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb, schema, type DB } from "@/db";
import { classifyAll, makeContext, type ClassifiedLine } from "@/domain/ledger";
import type { Account, AccountType, Category, LiquidityTier, Owner, TaxBucket, Transaction } from "@/domain/types";
import type { SplitPolicy } from "@/domain/couple";

/** Mapping between DB rows and pure domain types. */

export type AccountRow = typeof schema.accounts.$inferSelect;
export type TxnRow = typeof schema.transactions.$inferSelect;

export function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    name: r.name,
    type: r.type as AccountType,
    owner: r.owner as Owner,
    balance: r.balance,
    creditLimit: r.creditLimit,
    apr: r.apr,
    minPayment: r.minPayment,
    promoAprEnd: r.promoAprEnd,
    statementCloseDay: r.statementCloseDay,
    taxBucket: (r.taxBucket as TaxBucket) ?? undefined,
    liquidity: (r.liquidity as LiquidityTier) ?? undefined,
    isHidden: r.isHidden,
    excludeFromCashFlow: r.excludeFromCashFlow,
  };
}

export function toCategory(r: typeof schema.categories.$inferSelect): Category {
  return {
    id: r.id,
    name: r.name,
    group: r.group,
    budgetType: r.budgetType as Category["budgetType"],
    essential: r.essential,
    isTransferLike: r.isTransferLike,
    isPersonalAllowance: r.isPersonalAllowance,
  };
}

export function toTxn(r: TxnRow, splits: Array<typeof schema.transactionSplits.$inferSelect> = []): Transaction {
  return {
    id: r.id,
    accountId: r.accountId,
    date: r.date,
    amount: r.amount,
    payeeRaw: r.payeeRaw,
    merchant: r.merchant,
    categoryId: r.categoryId,
    owner: (r.owner as Owner) ?? undefined,
    isShared: r.isShared,
    isPrivate: r.isPrivate,
    isTransfer: r.isTransfer,
    transferPairId: r.transferPairId,
    isReimbursable: r.isReimbursable,
    reimbursementOfId: r.reimbursementOfId,
    refundOfId: r.refundOfId,
    pending: r.pending,
    isHidden: r.isHidden,
    isSettlement: r.isSettlement,
    externalId: r.externalId,
    tags: r.tags ?? [],
    notes: r.notes,
    splits: splits.length
      ? splits.map((s) => ({ splitId: s.id, amount: s.amount, categoryId: s.categoryId, owner: (s.owner as Owner) ?? undefined, tags: s.tags ?? [] }))
      : undefined,
  };
}

export function loadAccounts(householdId: string, db: DB = getDb()): AccountRow[] {
  return db.select().from(schema.accounts).where(eq(schema.accounts.householdId, householdId)).orderBy(asc(schema.accounts.sortOrder), asc(schema.accounts.name)).all();
}

export function loadCategories(householdId: string, db: DB = getDb()) {
  return db.select().from(schema.categories).where(eq(schema.categories.householdId, householdId)).orderBy(asc(schema.categories.sortOrder)).all();
}

export function loadTxnRows(householdId: string, opts: { start?: string; end?: string; accountId?: string } = {}, db: DB = getDb()): TxnRow[] {
  const conds = [eq(schema.transactions.householdId, householdId)];
  if (opts.start) conds.push(gte(schema.transactions.date, opts.start));
  if (opts.end) conds.push(lte(schema.transactions.date, opts.end));
  if (opts.accountId) conds.push(eq(schema.transactions.accountId, opts.accountId));
  return db.select().from(schema.transactions).where(and(...conds)).orderBy(desc(schema.transactions.date), desc(schema.transactions.createdAt)).all();
}

export function loadSplits(txnIds: string[], db: DB = getDb()) {
  const out = new Map<string, Array<typeof schema.transactionSplits.$inferSelect>>();
  // Chunk to stay under SQLite's variable limit.
  for (let i = 0; i < txnIds.length; i += 500) {
    const chunk = txnIds.slice(i, i + 500);
    if (!chunk.length) continue;
    for (const s of db.select().from(schema.transactionSplits).where(inArray(schema.transactionSplits.transactionId, chunk)).all()) {
      (out.get(s.transactionId) ?? out.set(s.transactionId, []).get(s.transactionId)!).push(s);
    }
  }
  return out;
}

export interface Ledger {
  accounts: Account[];
  accountRows: AccountRow[];
  categories: Category[];
  txns: Transaction[];
  lines: ClassifiedLine[];
}

/** Load and classify everything for a date window. Transfer pairs outside the window are pulled in so classification is correct. */
export function loadLedger(householdId: string, opts: { start?: string; end?: string } = {}, db: DB = getDb()): Ledger {
  const accountRows = loadAccounts(householdId, db);
  const accounts = accountRows.map(toAccount);
  const categories = loadCategories(householdId, db).map(toCategory);
  const rows = loadTxnRows(householdId, opts, db);
  const splits = loadSplits(rows.map((r) => r.id), db);
  const txns = rows.map((r) => toTxn(r, splits.get(r.id)));
  const ids = new Set(txns.map((t) => t.id));
  const missingPairs = txns.map((t) => t.transferPairId).filter((x): x is string => !!x && !ids.has(x));
  const pairRows = missingPairs.length ? db.select().from(schema.transactions).where(inArray(schema.transactions.id, missingPairs.slice(0, 900))).all() : [];
  const ctx = makeContext(accounts, categories, [...txns, ...pairRows.map((r) => toTxn(r))]);
  return { accounts, accountRows, categories, txns, lines: classifyAll(txns, ctx) };
}

export function getHousehold(householdId: string, db: DB = getDb()) {
  const h = db.select().from(schema.households).where(eq(schema.households.id, householdId)).get();
  if (!h) throw new Error("Household not found");
  const settings = (h.settings ?? {}) as { partnerNames?: { A: string; B: string }; lowBalanceFloor?: number; largeTxnThreshold?: number; retirement?: Record<string, number>; emergencyMonths?: number };
  const names = settings.partnerNames ?? { A: "Partner A", B: "Partner B" };
  const policy: SplitPolicy = (h.splitPolicy as unknown as SplitPolicy) ?? { default: { mode: "income" }, incomeA: 0, incomeB: 0 };
  return { ...h, settings, names, policy };
}

export function ownerLabel(o: Owner | null | undefined, names: { A: string; B: string }): string {
  if (o === "A") return names.A;
  if (o === "B") return names.B;
  return "Joint";
}

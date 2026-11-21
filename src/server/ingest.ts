import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb, schema, type DB } from "@/db";
import { judgeIncoming, fingerprint } from "@/domain/dedupe";
import { cleanPayee, merchantKey } from "@/domain/merchant";
import { suggestCategory, type Rule } from "@/domain/rules";
import { detectTransfers } from "@/domain/transfers";
import { addDays } from "@/domain/money";
import { PROVIDER_CATEGORY_HINTS } from "@/domain/categories";
import type { Owner, Transaction } from "@/domain/types";
import { newId } from "./crypto";
import { catId } from "./seed";
import { toAccount, toTxn } from "./repo";

export interface IncomingTxn {
  date: string;
  amount: number;
  payee: string;
  externalId?: string | null;
  pending?: boolean;
  providerCategory?: string | null;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  replacedPending: number;
  flaggedDuplicates: number;
  transfersLinked: number;
  transfersSuggested: number;
}

export function loadRules(householdId: string, db: DB): Rule[] {
  return db
    .select()
    .from(schema.rules)
    .where(eq(schema.rules.householdId, householdId))
    .all()
    .map((r) => ({ id: r.id, name: r.name ?? undefined, priority: r.priority, enabled: r.enabled, conditions: r.conditions as Rule["conditions"], actions: r.actions as Rule["actions"] }));
}

export function loadMerchantMemory(householdId: string, db: DB): Map<string, string> {
  return new Map(db.select().from(schema.merchantMemory).where(eq(schema.merchantMemory.householdId, householdId)).all().map((m) => [m.merchantKey, m.categoryId]));
}

function providerCategoryId(householdId: string, provider: string | null | undefined): string | null {
  if (!provider) return null;
  for (const [re, slug] of PROVIDER_CATEGORY_HINTS) if (re.test(provider)) return catId(householdId, slug);
  return null;
}

/**
 * Ingest transactions for one account. Idempotent: re-running with the same
 * data updates rather than duplicates. Never silently drops a possible
 * duplicate; it is inserted and flagged for review.
 */
export function ingest(
  householdId: string,
  accountId: string,
  source: "simplefin" | "csv" | "ofx" | "manual",
  incoming: IncomingTxn[],
  db: DB = getDb(),
  userId?: string,
): IngestResult {
  const result: IngestResult = { inserted: 0, updated: 0, replacedPending: 0, flaggedDuplicates: 0, transfersLinked: 0, transfersSuggested: 0 };
  if (incoming.length === 0) return result;
  const acct = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!acct) throw new Error("Unknown account");
  const minDate = addDays(incoming.reduce((m, t) => (t.date < m ? t.date : m), incoming[0]!.date), -7);
  const existingRows = db
    .select()
    .from(schema.transactions)
    .where(and(eq(schema.transactions.accountId, accountId), gte(schema.transactions.date, minDate)))
    .all();
  const existing: Transaction[] = existingRows.map((r) => toTxn(r));
  const rules = loadRules(householdId, db);
  const memory = loadMerchantMemory(householdId, db);
  const now = new Date().toISOString();

  // Rows without a bank id get a stable fingerprint so re-importing the same file is a no-op.
  const seen = new Map<string, number>();
  const withIds = incoming.map((t) => {
    if (t.externalId) return t;
    const base = fingerprint({ accountId, date: t.date, amount: t.amount, payeeRaw: t.payee });
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...t, externalId: `fp:${fingerprint({ accountId, date: t.date, amount: t.amount, payeeRaw: t.payee }, n)}` };
  });

  db.transaction((tx) => {
    for (const inc of withIds) {
      const candidate: Transaction = {
        id: newId(),
        accountId,
        date: inc.date,
        amount: inc.amount,
        payeeRaw: inc.payee,
        categoryId: null,
        pending: !!inc.pending,
        externalId: inc.externalId,
      };
      const verdict = judgeIncoming(candidate, existing);
      if (verdict.kind === "update") {
        const prev = existingRows.find((r) => r.id === verdict.existingId)!;
        // Only bank-owned fields change; user edits (category, notes...) are preserved.
        if (prev.amount !== inc.amount || prev.date !== inc.date || prev.pending !== !!inc.pending || prev.payeeRaw !== inc.payee) {
          tx.update(schema.transactions)
            .set({ amount: inc.amount, date: inc.date, pending: !!inc.pending, payeeRaw: inc.payee, updatedAt: now })
            .where(eq(schema.transactions.id, prev.id))
            .run();
          result.updated++;
        }
        continue;
      }
      const merchant = cleanPayee(inc.payee);
      const sug = suggestCategory(
        { ...candidate, merchant, accountOwner: acct.owner as Owner },
        rules,
        memory,
        providerCategoryId(householdId, inc.providerCategory),
      );
      const p = sug.patch;
      const values: typeof schema.transactions.$inferInsert = {
        id: candidate.id,
        householdId,
        accountId,
        externalId: inc.externalId,
        source,
        date: inc.date,
        amount: inc.amount,
        payeeRaw: inc.payee,
        merchant: p.merchant ?? merchant,
        categoryId: sug.categoryId,
        categorySource: sug.source,
        owner: p.owner ?? null,
        isShared: p.isShared ?? false,
        isTransfer: p.isTransfer ?? false,
        isReimbursable: p.isReimbursable ?? false,
        isHidden: p.isHidden ?? false,
        pending: !!inc.pending,
        tags: p.tags ?? [],
        createdBy: userId ?? null,
      };

      if (verdict.kind === "replaces_pending") {
        const old = existingRows.find((r) => r.id === verdict.existingId)!;
        // Keep the user's work from the pending version.
        tx.update(schema.transactions)
          .set({
            externalId: inc.externalId,
            amount: inc.amount,
            date: inc.date,
            payeeRaw: inc.payee,
            pending: false,
            categoryId: old.categorySource === "user" ? old.categoryId : old.categoryId ?? values.categoryId,
            updatedAt: now,
          })
          .where(eq(schema.transactions.id, old.id))
          .run();
        result.replacedPending++;
        continue;
      }
      if (verdict.kind === "possible_duplicate") {
        values.possibleDuplicateOf = verdict.existingId;
        result.flaggedDuplicates++;
      }
      tx.insert(schema.transactions).values(values).run();
      if (p.splits?.length) {
        for (const s of p.splits) tx.insert(schema.transactionSplits).values({ id: newId(), transactionId: candidate.id, amount: s.amount, categoryId: s.categoryId }).run();
      }
      existing.push({ ...candidate, categoryId: values.categoryId ?? null });
      result.inserted++;
    }
  });

  const t = linkTransfers(householdId, minDate, db);
  result.transfersLinked = t.linked;
  result.transfersSuggested = t.suggested;
  return result;
}

/** Run transfer detection across all household accounts from `since`. High confidence pairs are linked; medium ones are suggested. */
export function linkTransfers(householdId: string, since: string, db: DB = getDb()): { linked: number; suggested: number } {
  const accounts = db.select().from(schema.accounts).where(eq(schema.accounts.householdId, householdId)).all().map(toAccount);
  const rows = db
    .select()
    .from(schema.transactions)
    .where(and(eq(schema.transactions.householdId, householdId), gte(schema.transactions.date, addDays(since, -5))))
    .all();
  const candidates = rows.filter((r) => !r.transferPairId && !r.transferSuggestedPairId).map((r) => toTxn(r));
  const matches = detectTransfers(candidates, accounts);
  const transferCat = catId(householdId, "transfers_transfer");
  const ccCat = catId(householdId, "transfers_credit_card_payment");
  const acctType = new Map(accounts.map((a) => [a.id, a.type]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let linked = 0;
  let suggested = 0;
  db.transaction((tx) => {
    for (const m of matches) {
      if (m.confidence === "high") {
        const inflow = byId.get(m.inflowId)!;
        const cat = acctType.get(inflow.accountId) === "credit_card" ? ccCat : transferCat;
        for (const [a, b] of [
          [m.outflowId, m.inflowId],
          [m.inflowId, m.outflowId],
        ] as const) {
          const row = byId.get(a)!;
          // A user-chosen category on the cash leg (e.g. "Car payment") is kept.
          const keepCat = row.categorySource === "user" || row.categorySource === "rule";
          tx.update(schema.transactions)
            .set({ isTransfer: true, transferPairId: b, categoryId: keepCat ? row.categoryId : cat, categorySource: keepCat ? row.categorySource : "transfer" })
            .where(eq(schema.transactions.id, a))
            .run();
        }
        linked++;
      } else {
        tx.update(schema.transactions).set({ transferSuggestedPairId: m.inflowId }).where(eq(schema.transactions.id, m.outflowId)).run();
        tx.update(schema.transactions).set({ transferSuggestedPairId: m.outflowId }).where(eq(schema.transactions.id, m.inflowId)).run();
        suggested++;
      }
    }
  });
  return { linked, suggested };
}

/** Remember a human categorization for the merchant (used as the 2nd fallback after rules). */
export function rememberMerchant(householdId: string, merchant: string, categoryId: string, db: DB = getDb()) {
  db.insert(schema.merchantMemory)
    .values({ householdId, merchantKey: merchantKey(merchant), categoryId, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: [schema.merchantMemory.householdId, schema.merchantMemory.merchantKey], set: { categoryId, updatedAt: new Date().toISOString() } })
    .run();
}

export function unlinkTransfer(txnId: string, db: DB = getDb()) {
  const t = db.select().from(schema.transactions).where(eq(schema.transactions.id, txnId)).get();
  if (!t) return;
  const ids = [t.id, t.transferPairId, t.transferSuggestedPairId].filter((x): x is string => !!x);
  db.update(schema.transactions)
    .set({ isTransfer: false, transferPairId: null, transferSuggestedPairId: null, categoryId: null, categorySource: "none" })
    .where(inArray(schema.transactions.id, ids))
    .run();
}

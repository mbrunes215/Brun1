"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { toCents, addMonths, monthKey } from "@/domain/money";
import { cleanPayee } from "@/domain/merchant";
import { defaultLiquidity, defaultTaxBucket, LIABILITY_TYPES } from "@/domain/accounts";
import { previewRule, type Rule } from "@/domain/rules";
import type { AccountType } from "@/domain/types";
import { requireUser, createInvite, beginTotpEnrollment, confirmTotpEnrollment, changePassword } from "./auth";
import { audit } from "./audit";
import { encrypt, newId } from "./crypto";
import { ingest, linkTransfers, rememberMerchant, unlinkTransfer, loadRules } from "./ingest";
import { syncConnection, upsertSnapshot, todayIn, MANUAL_SYNC_COOLDOWN_MIN } from "./sync";
import { claimAccessUrl } from "@/integrations/simplefin";
import { applyMapping, parseCsvText, parseOfx, type CsvMapping } from "@/integrations/fileImport";
import { toTxn } from "./repo";
import { monthBudget } from "./insights";

type Result = { error?: string; ok?: string } | undefined;

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const optCents = (fd: FormData, k: string) => {
  const v = str(fd, k);
  return v === "" ? null : toCents(v);
};
const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true" || fd.get(k) === "1";

async function me() {
  const u = await requireUser();
  return { u, hid: u.householdId, db: getDb() };
}

function assertMonthOpen(hid: string, date: string) {
  const closed = getDb()
    .select()
    .from(schema.monthCloses)
    .where(and(eq(schema.monthCloses.householdId, hid), eq(schema.monthCloses.month, monthKey(date))))
    .get();
  if (closed) throw new Error(`${monthKey(date)} is closed. Reopen it on the Monthly close page to edit.`);
}

function ownTxn(hid: string, id: string) {
  const t = getDb().select().from(schema.transactions).where(and(eq(schema.transactions.id, id), eq(schema.transactions.householdId, hid))).get();
  if (!t) throw new Error("Transaction not found");
  return t;
}

// ---------------- Transactions ----------------

export async function setTxnCategory(fd: FormData) {
  const { u, hid, db } = await me();
  const t = ownTxn(hid, str(fd, "id"));
  assertMonthOpen(hid, t.date);
  const categoryId = str(fd, "categoryId") || null;
  db.update(schema.transactions)
    .set({ categoryId, categorySource: "user", updatedAt: new Date().toISOString(), reviewedAt: t.reviewedAt ?? new Date().toISOString(), reviewedBy: t.reviewedBy ?? u.id })
    .where(eq(schema.transactions.id, t.id))
    .run();
  if (categoryId) rememberMerchant(hid, t.merchant ?? cleanPayee(t.payeeRaw), categoryId);
  audit(hid, u.id, "txn.category", "transaction", t.id, { from: t.categoryId, to: categoryId });
  revalidatePath("/transactions");
}

export async function markReviewed(fd: FormData) {
  const { u, hid, db } = await me();
  const ids = fd.getAll("ids").map(String).filter(Boolean);
  const now = new Date().toISOString();
  if (ids.length) {
    db.update(schema.transactions)
      .set({ reviewedAt: now, reviewedBy: u.id })
      .where(and(eq(schema.transactions.householdId, hid), inArray(schema.transactions.id, ids)))
      .run();
  }
  revalidatePath("/transactions");
}

export async function markAllReviewedBefore(fd: FormData) {
  const { u, hid, db } = await me();
  const date = str(fd, "date");
  const rows = db
    .select({ id: schema.transactions.id, date: schema.transactions.date })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.householdId, hid), isNull(schema.transactions.reviewedAt)))
    .all()
    .filter((r) => r.date <= date);
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    db.update(schema.transactions).set({ reviewedAt: now, reviewedBy: u.id }).where(inArray(schema.transactions.id, rows.slice(i, i + 500).map((r) => r.id))).run();
  }
  audit(hid, u.id, "txn.bulk_reviewed", undefined, undefined, { count: rows.length, through: date });
  revalidatePath("/", "layout");
}

export async function updateTxn(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const t = ownTxn(hid, str(fd, "id"));
    assertMonthOpen(hid, t.date);
    const owner = str(fd, "owner");
    const tags = str(fd, "tags").split(",").map((s) => s.trim()).filter(Boolean);
    const categoryId = str(fd, "categoryId") || null;
    db.update(schema.transactions)
      .set({
        merchant: str(fd, "merchant") || t.merchant,
        categoryId,
        categorySource: categoryId !== t.categoryId ? "user" : t.categorySource,
        owner: owner === "A" || owner === "B" || owner === "joint" ? owner : null,
        isShared: bool(fd, "isShared"),
        isReimbursable: bool(fd, "isReimbursable"),
        isHidden: bool(fd, "isHidden"),
        isSettlement: bool(fd, "isSettlement"),
        isPrivate: bool(fd, "isPrivate"),
        notes: str(fd, "notes") || null,
        tags,
        updatedAt: new Date().toISOString(),
        reviewedAt: t.reviewedAt ?? new Date().toISOString(),
        reviewedBy: t.reviewedBy ?? u.id,
      })
      .where(eq(schema.transactions.id, t.id))
      .run();
    if (categoryId && categoryId !== t.categoryId) rememberMerchant(hid, str(fd, "merchant") || t.merchant || cleanPayee(t.payeeRaw), categoryId);
    // Settlements feed the settle-up ledger.
    if (bool(fd, "isSettlement") && !t.isSettlement && t.amount < 0) {
      const acct = db.select().from(schema.accounts).where(eq(schema.accounts.id, t.accountId)).get();
      const from = (acct?.owner === "B" ? "B" : "A") as "A" | "B";
      db.insert(schema.settlements).values({ id: newId(), householdId: hid, date: t.date, from, to: from === "A" ? "B" : "A", amount: -t.amount, txnId: t.id }).run();
    }
    audit(hid, u.id, "txn.update", "transaction", t.id);
    revalidatePath("/transactions");
    return { ok: "Saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function saveSplits(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const t = ownTxn(hid, str(fd, "id"));
    assertMonthOpen(hid, t.date);
    const amounts = fd.getAll("splitAmount").map(String);
    const cats = fd.getAll("splitCategory").map(String);
    const owners = fd.getAll("splitOwner").map(String);
    const lines = amounts
      .map((a, i) => ({ amount: a.trim() ? toCents(a) * (t.amount < 0 ? -1 : 1) : 0, categoryId: cats[i] || null, owner: owners[i] || null }))
      .filter((l) => l.amount !== 0);
    if (lines.length === 1) return { error: "A split needs at least two lines (or clear all lines to remove the split)." };
    if (lines.length > 0) {
      const total = lines.reduce((s, l) => s + l.amount, 0);
      if (total !== t.amount) return { error: `Split lines add up to ${(Math.abs(total) / 100).toFixed(2)} but the transaction is ${(Math.abs(t.amount) / 100).toFixed(2)}.` };
    }
    db.transaction((tx) => {
      tx.delete(schema.transactionSplits).where(eq(schema.transactionSplits.transactionId, t.id)).run();
      for (const l of lines) {
        tx.insert(schema.transactionSplits)
          .values({ id: newId(), transactionId: t.id, amount: l.amount, categoryId: l.categoryId, owner: (l.owner as "A" | "B" | "joint" | null) || null })
          .run();
      }
    });
    audit(hid, u.id, "txn.split", "transaction", t.id, { lines: lines.length });
    revalidatePath(`/transactions/${t.id}`);
    return { ok: lines.length ? "Split saved." : "Split removed." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function confirmTransferSuggestion(fd: FormData) {
  const { u, hid, db } = await me();
  const t = ownTxn(hid, str(fd, "id"));
  const pairId = t.transferSuggestedPairId;
  if (!pairId) return;
  const pair = ownTxn(hid, pairId);
  db.update(schema.transactions).set({ isTransfer: true, transferPairId: pair.id, transferSuggestedPairId: null }).where(eq(schema.transactions.id, t.id)).run();
  db.update(schema.transactions).set({ isTransfer: true, transferPairId: t.id, transferSuggestedPairId: null }).where(eq(schema.transactions.id, pair.id)).run();
  audit(hid, u.id, "txn.transfer_confirmed", "transaction", t.id);
  revalidatePath("/transactions");
}

export async function rejectTransferSuggestion(fd: FormData) {
  const { hid, db } = await me();
  const t = ownTxn(hid, str(fd, "id"));
  const ids = [t.id, t.transferSuggestedPairId].filter((x): x is string => !!x);
  // Mark as reviewed-not-transfer by clearing suggestion and pointing to self so detection skips it.
  db.update(schema.transactions).set({ transferSuggestedPairId: "rejected" }).where(inArray(schema.transactions.id, ids)).run();
  revalidatePath("/transactions");
}

export async function unlinkTransferAction(fd: FormData) {
  const { u, hid } = await me();
  const t = ownTxn(hid, str(fd, "id"));
  unlinkTransfer(t.id);
  audit(hid, u.id, "txn.transfer_unlinked", "transaction", t.id);
  revalidatePath(`/transactions/${t.id}`);
}

export async function resolveDuplicate(fd: FormData) {
  const { u, hid, db } = await me();
  const t = ownTxn(hid, str(fd, "id"));
  const decision = str(fd, "decision");
  if (decision === "delete") {
    db.delete(schema.transactions).where(eq(schema.transactions.id, t.id)).run();
    audit(hid, u.id, "txn.duplicate_deleted", "transaction", t.id, { duplicateOf: t.possibleDuplicateOf });
  } else {
    db.update(schema.transactions).set({ possibleDuplicateOf: null }).where(eq(schema.transactions.id, t.id)).run();
  }
  revalidatePath("/transactions");
}

export async function addManualTxn(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid } = await me();
    const accountId = str(fd, "accountId");
    const date = str(fd, "date");
    assertMonthOpen(hid, date);
    const amt = toCents(str(fd, "amount"));
    const signed = str(fd, "direction") === "in" ? Math.abs(amt) : -Math.abs(amt);
    ingest(hid, accountId, "manual", [{ date, amount: signed, payee: str(fd, "payee"), externalId: `manual:${newId()}` }], getDb(), u.id);
    revalidatePath("/transactions");
    return { ok: "Added." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

// ---------------- Rules ----------------

export async function createRule(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const conditions: Rule["conditions"] = {};
    const field = str(fd, "matchField");
    const value = str(fd, "matchValue");
    if (!value) return { error: "Enter text to match." };
    if (field === "merchant") conditions.merchantEquals = value;
    else if (field === "regex") {
      try {
        new RegExp(value, "i");
      } catch {
        return { error: "That regular expression is invalid." };
      }
      conditions.payeeRegex = value;
    } else conditions.payeeContains = value;
    const min = optCents(fd, "amountMin");
    const max = optCents(fd, "amountMax");
    if (min != null) conditions.amountMin = min;
    if (max != null) conditions.amountMax = max;
    const dir = str(fd, "direction");
    if (dir === "outflow" || dir === "inflow") conditions.direction = dir;
    const actions: Rule["actions"] = {};
    if (str(fd, "categoryId")) actions.setCategoryId = str(fd, "categoryId");
    if (str(fd, "rename")) actions.setMerchant = str(fd, "rename");
    const owner = str(fd, "owner");
    if (owner === "A" || owner === "B" || owner === "joint") actions.setOwner = owner;
    if (bool(fd, "shared")) actions.setShared = true;
    if (bool(fd, "reimbursable")) actions.markReimbursable = true;
    if (bool(fd, "hide")) actions.hide = true;
    const tags = str(fd, "tags").split(",").map((s) => s.trim()).filter(Boolean);
    if (tags.length) actions.addTags = tags;
    if (Object.keys(actions).length === 0) return { error: "Choose at least one action." };
    const id = newId();
    db.insert(schema.rules).values({ id, householdId: hid, name: str(fd, "name") || value, priority: Number(str(fd, "priority") || 100), enabled: true, conditions: conditions as Record<string, unknown>, actions: actions as Record<string, unknown> }).run();
    audit(hid, u.id, "rule.create", "rule", id, { conditions: conditions as Record<string, unknown>, actions: actions as Record<string, unknown> });
    let applied = 0;
    if (bool(fd, "applyPast") && actions.setCategoryId) {
      const rule: Rule = { id, priority: 100, enabled: true, conditions, actions };
      const rows = db.select().from(schema.transactions).where(eq(schema.transactions.householdId, hid)).all();
      const closed = new Set(db.select().from(schema.monthCloses).where(eq(schema.monthCloses.householdId, hid)).all().map((c) => c.month));
      const changes = previewRule(rule, rows.filter((r) => !closed.has(monthKey(r.date)) && r.categorySource !== "user").map((r) => toTxn(r)));
      for (const c of changes) db.update(schema.transactions).set({ categoryId: c.to, categorySource: "rule" }).where(eq(schema.transactions.id, c.id)).run();
      applied = changes.length;
    }
    revalidatePath("/settings/rules");
    return { ok: applied ? `Rule saved and applied to ${applied} past transaction${applied > 1 ? "s" : ""}.` : "Rule saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function toggleRule(fd: FormData) {
  const { hid, db } = await me();
  const id = str(fd, "id");
  const r = db.select().from(schema.rules).where(and(eq(schema.rules.id, id), eq(schema.rules.householdId, hid))).get();
  if (r) db.update(schema.rules).set({ enabled: !r.enabled }).where(eq(schema.rules.id, id)).run();
  revalidatePath("/settings/rules");
}

export async function deleteRule(fd: FormData) {
  const { u, hid, db } = await me();
  db.delete(schema.rules).where(and(eq(schema.rules.id, str(fd, "id")), eq(schema.rules.householdId, hid))).run();
  audit(hid, u.id, "rule.delete", "rule", str(fd, "id"));
  revalidatePath("/settings/rules");
}

export async function previewRuleAction(fd: FormData): Promise<number> {
  const { hid, db } = await me();
  const rules = loadRules(hid, db);
  const r = rules.find((x) => x.id === str(fd, "id"));
  if (!r) return 0;
  const rows = db.select().from(schema.transactions).where(eq(schema.transactions.householdId, hid)).all();
  return previewRule(r, rows.map((x) => toTxn(x))).length;
}

// ---------------- Accounts ----------------

export async function saveAccount(_: Result, fd: FormData): Promise<Result> {
  let id = str(fd, "id");
  try {
    const { u, hid, db } = await me();
    const type = str(fd, "type") as AccountType;
    const owner = str(fd, "owner") as "A" | "B" | "joint";
    const balanceIn = optCents(fd, "balance");
    const values = {
      name: str(fd, "name"),
      type,
      owner,
      institution: str(fd, "institution") || null,
      creditLimit: optCents(fd, "creditLimit"),
      apr: str(fd, "apr") ? Number(str(fd, "apr")) / 100 : null,
      minPayment: optCents(fd, "minPayment"),
      promoAprEnd: str(fd, "promoAprEnd") || null,
      statementCloseDay: str(fd, "statementCloseDay") ? Number(str(fd, "statementCloseDay")) : null,
      taxBucket: str(fd, "taxBucket") || defaultTaxBucket(type),
      liquidity: str(fd, "liquidity") || defaultLiquidity(type),
      isHidden: bool(fd, "isHidden"),
      excludeFromCashFlow: bool(fd, "excludeFromCashFlow"),
      valueChangeRate: str(fd, "valueChangeRate") ? Number(str(fd, "valueChangeRate")) / 100 : null,
      linkedAssetId: str(fd, "linkedAssetId") || null,
    };
    if (!values.name) return { error: "Name is required." };
    const hh = db.select().from(schema.households).where(eq(schema.households.id, hid)).get()!;
    const today = todayIn(hh.timezone);
    // Manual balances are entered as positive "amount owed" for debts.
    const normalized = balanceIn == null ? null : LIABILITY_TYPES.has(type) ? -Math.abs(balanceIn) : balanceIn;
    if (id) {
      const existing = db.select().from(schema.accounts).where(and(eq(schema.accounts.id, id), eq(schema.accounts.householdId, hid))).get();
      if (!existing) return { error: "Not found" };
      db.update(schema.accounts)
        .set({ ...values, ...(existing.isManual && normalized != null ? { balance: normalized, balanceDate: today } : {}) })
        .where(eq(schema.accounts.id, id))
        .run();
      if (existing.isManual && normalized != null) upsertSnapshot(id, today, normalized);
      audit(hid, u.id, "account.update", "account", id);
    } else {
      id = newId();
      db.insert(schema.accounts).values({ id, householdId: hid, ...values, isManual: true, balance: normalized ?? 0, balanceDate: today }).run();
      upsertSnapshot(id, today, normalized ?? 0);
      audit(hid, u.id, "account.create", "account", id);
    }
    revalidatePath("/accounts");
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
  redirect(`/accounts/${id}?saved=1`);
}

export async function deleteAccount(fd: FormData) {
  const { u, hid, db } = await me();
  const id = str(fd, "id");
  const a = db.select().from(schema.accounts).where(and(eq(schema.accounts.id, id), eq(schema.accounts.householdId, hid))).get();
  if (!a) return;
  db.transaction((tx) => {
    tx.delete(schema.transactions).where(eq(schema.transactions.accountId, id)).run();
    tx.delete(schema.balanceSnapshots).where(eq(schema.balanceSnapshots.accountId, id)).run();
    tx.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
  });
  audit(hid, u.id, "account.delete", "account", id, { name: a.name });
  redirect("/accounts");
}

// ---------------- Connections ----------------

export async function connectSimpleFin(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const token = str(fd, "token");
    if (!token) return { error: "Paste your SimpleFIN setup token." };
    const access = await claimAccessUrl(token);
    const id = newId();
    db.insert(schema.connections).values({ id, householdId: hid, provider: "simplefin", accessUrlEnc: encrypt(access), label: str(fd, "label") || "SimpleFIN" }).run();
    audit(hid, u.id, "connection.create", "connection", id);
    const s = await syncConnection(id);
    revalidatePath("/", "layout");
    return { ok: `Connected. Found ${s.accountsSeen} accounts and ${s.totals.inserted} transactions. Review account types and owners on the Accounts page.${s.errors.length ? " Notes from your bank: " + s.errors.join("; ") : ""}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Connection failed" };
  }
}

export async function syncNow(_: Result, fd: FormData): Promise<Result> {
  try {
    const { hid, db } = await me();
    const c = db.select().from(schema.connections).where(and(eq(schema.connections.id, str(fd, "id")), eq(schema.connections.householdId, hid))).get();
    if (!c) return { error: "Not found" };
    if (c.lastSyncedAt && Date.now() - Date.parse(c.lastSyncedAt) < MANUAL_SYNC_COOLDOWN_MIN * 60_000) {
      return { error: `Synced less than ${MANUAL_SYNC_COOLDOWN_MIN} minutes ago. SimpleFIN limits daily requests, and banks usually update once a day anyway.` };
    }
    const s = await syncConnection(c.id);
    revalidatePath("/", "layout");
    return { ok: `Synced: ${s.totals.inserted} new, ${s.totals.updated} updated, ${s.totals.transfersLinked} transfers linked.${s.errors.length ? " " + s.errors.join("; ") : ""}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Sync failed" };
  }
}

export async function removeConnection(fd: FormData) {
  const { u, hid, db } = await me();
  const id = str(fd, "id");
  db.delete(schema.connections).where(and(eq(schema.connections.id, id), eq(schema.connections.householdId, hid))).run();
  // Accounts and history are kept as manual accounts.
  db.update(schema.accounts).set({ connectionId: null, isManual: true }).where(eq(schema.accounts.connectionId, id)).run();
  audit(hid, u.id, "connection.delete", "connection", id);
  revalidatePath("/settings/connections");
}

// ---------------- Import ----------------

export async function importFile(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid } = await me();
    const accountId = str(fd, "accountId");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a file." };
    if (file.size > 10 * 1024 * 1024) return { error: "File is larger than 10 MB." };
    const text = await file.text();
    let rows;
    let errors: string[] = [];
    let source: "csv" | "ofx" = "csv";
    if (/<OFX>|OFXHEADER/i.test(text)) {
      rows = parseOfx(text);
      source = "ofx";
    } else {
      const { rows: raw } = parseCsvText(text);
      const mapping: CsvMapping = {
        date: str(fd, "colDate"),
        description: str(fd, "colDescription"),
        amount: str(fd, "colAmount") || undefined,
        debit: str(fd, "colDebit") || undefined,
        credit: str(fd, "colCredit") || undefined,
        flipSign: bool(fd, "flipSign"),
        dateFormat: (str(fd, "dateFormat") as CsvMapping["dateFormat"]) || "auto",
      };
      if (!mapping.date || !mapping.description || (!mapping.amount && !mapping.debit && !mapping.credit)) return { error: "Map the date, description, and amount columns." };
      ({ rows, errors } = applyMapping(raw, mapping));
      // Remember the mapping for this account.
      const db = getDb();
      const hh = db.select().from(schema.households).where(eq(schema.households.id, hid)).get()!;
      const settings = (hh.settings ?? {}) as Record<string, unknown>;
      const maps = (settings.csvMappings ?? {}) as Record<string, CsvMapping>;
      db.update(schema.households).set({ settings: { ...settings, csvMappings: { ...maps, [accountId]: mapping } } }).where(eq(schema.households.id, hid)).run();
    }
    const r = ingest(hid, accountId, source, rows.map((x) => ({ date: x.date, amount: x.amount, payee: x.payee, externalId: x.externalId, providerCategory: x.category })), getDb(), u.id);
    audit(hid, u.id, "import.file", "account", accountId, { ...r, rows: rows.length });
    revalidatePath("/", "layout");
    return {
      ok: `Imported ${r.inserted} new transactions (${rows.length - r.inserted - r.updated} already present).${r.flaggedDuplicates ? ` ${r.flaggedDuplicates} possible duplicates flagged for review.` : ""}${r.transfersLinked ? ` ${r.transfersLinked} transfers linked.` : ""}${errors.length ? ` Skipped ${errors.length} unreadable rows (${errors.slice(0, 3).join("; ")}).` : ""}`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Import failed" };
  }
}

// ---------------- Budget ----------------

function ensureBudgetMonth(hid: string, month: string) {
  const db = getDb();
  let bm = db.select().from(schema.budgetMonths).where(and(eq(schema.budgetMonths.householdId, hid), eq(schema.budgetMonths.month, month))).get();
  if (!bm) {
    const id = newId();
    db.insert(schema.budgetMonths).values({ id, householdId: hid, month }).run();
    bm = db.select().from(schema.budgetMonths).where(eq(schema.budgetMonths.id, id)).get()!;
  }
  return bm;
}

export async function saveBudgetPlan(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const month = str(fd, "month");
    const bm = ensureBudgetMonth(hid, month);
    db.update(schema.budgetMonths)
      .set({
        expectedIncome: optCents(fd, "expectedIncome") ?? 0,
        flexTotal: optCents(fd, "flexTotal"),
        flexRollover: bool(fd, "flexRollover"),
        savingsGoals: optCents(fd, "savingsGoals") ?? 0,
      })
      .where(eq(schema.budgetMonths.id, bm.id))
      .run();
    const catIds = fd.getAll("lineCategory").map(String);
    const amts = fd.getAll("lineAmount").map(String);
    const rolls = new Set(fd.getAll("lineRollover").map(String));
    db.transaction((tx) => {
      tx.delete(schema.budgetLines).where(eq(schema.budgetLines.budgetMonthId, bm.id)).run();
      catIds.forEach((cid, i) => {
        const a = amts[i]?.trim();
        if (!cid || !a) return;
        const cents = toCents(a);
        if (cents <= 0) return;
        tx.insert(schema.budgetLines).values({ id: newId(), budgetMonthId: bm.id, categoryId: cid, amount: cents, rollover: rolls.has(cid) }).run();
      });
    });
    audit(hid, u.id, "budget.save", "budget_month", bm.id, { month });
    revalidatePath("/budget");
    return { ok: "Plan saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function copyBudgetFrom(fd: FormData) {
  const { u, hid, db } = await me();
  const month = str(fd, "month");
  const from = str(fd, "from") || addMonths(month, -1);
  const src = db.select().from(schema.budgetMonths).where(and(eq(schema.budgetMonths.householdId, hid), eq(schema.budgetMonths.month, from))).get();
  if (!src) return;
  const bm = ensureBudgetMonth(hid, month);
  db.update(schema.budgetMonths).set({ expectedIncome: src.expectedIncome, flexTotal: src.flexTotal, flexRollover: src.flexRollover, savingsGoals: src.savingsGoals }).where(eq(schema.budgetMonths.id, bm.id)).run();
  db.delete(schema.budgetLines).where(eq(schema.budgetLines.budgetMonthId, bm.id)).run();
  for (const l of db.select().from(schema.budgetLines).where(eq(schema.budgetLines.budgetMonthId, src.id)).all()) {
    db.insert(schema.budgetLines).values({ id: newId(), budgetMonthId: bm.id, categoryId: l.categoryId, amount: l.amount, rollover: l.rollover }).run();
  }
  audit(hid, u.id, "budget.copy", "budget_month", bm.id, { from });
  revalidatePath("/budget");
}

export async function saveVarianceNote(fd: FormData) {
  const { hid, db } = await me();
  const bm = ensureBudgetMonth(hid, str(fd, "month"));
  const cid = str(fd, "categoryId");
  const existing = db.select().from(schema.budgetLines).where(and(eq(schema.budgetLines.budgetMonthId, bm.id), eq(schema.budgetLines.categoryId, cid))).get();
  if (existing) db.update(schema.budgetLines).set({ varianceNote: str(fd, "note") || null }).where(eq(schema.budgetLines.id, existing.id)).run();
  else db.insert(schema.budgetLines).values({ id: newId(), budgetMonthId: bm.id, categoryId: cid, amount: 0, varianceNote: str(fd, "note") || null }).run();
  revalidatePath("/close");
}

export async function saveFund(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const id = str(fd, "id") || newId();
    const values = {
      name: str(fd, "name"),
      categoryIds: fd.getAll("categoryIds").map(String).filter(Boolean),
      target: toCents(str(fd, "target") || "0"),
      nextDue: str(fd, "nextDue"),
      recurrence: (str(fd, "recurrence") || "annual") as "none" | "annual" | "semiannual" | "quarterly",
      backingAccountId: str(fd, "backingAccountId") || null,
    };
    if (!values.name || !values.nextDue || values.target <= 0) return { error: "Name, target, and due date are required." };
    const exists = db.select().from(schema.sinkingFunds).where(and(eq(schema.sinkingFunds.id, id), eq(schema.sinkingFunds.householdId, hid))).get();
    if (exists) db.update(schema.sinkingFunds).set(values).where(eq(schema.sinkingFunds.id, id)).run();
    else db.insert(schema.sinkingFunds).values({ id, householdId: hid, ...values }).run();
    const starting = optCents(fd, "startingBalance");
    if (!exists && starting) db.insert(schema.sinkingFundLedger).values({ id: newId(), fundId: id, date: str(fd, "today") || new Date().toISOString().slice(0, 10), amount: starting, kind: "adjustment", note: "Starting balance" }).run();
    audit(hid, u.id, exists ? "fund.update" : "fund.create", "sinking_fund", id);
    revalidatePath("/budget");
    return { ok: "Fund saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function contributeFunds(fd: FormData) {
  const { u, hid, db } = await me();
  const month = str(fd, "month");
  const date = str(fd, "date");
  const ids = fd.getAll("fundId").map(String);
  const amts = fd.getAll("amount").map(String);
  const funds = new Set(db.select().from(schema.sinkingFunds).where(eq(schema.sinkingFunds.householdId, hid)).all().map((f) => f.id));
  ids.forEach((fid, i) => {
    const a = amts[i]?.trim();
    if (!funds.has(fid) || !a) return;
    const cents = toCents(a);
    if (cents === 0) return;
    db.insert(schema.sinkingFundLedger).values({ id: newId(), fundId: fid, date, amount: cents, kind: "contribution", note: `Set-aside for ${month}` }).run();
  });
  audit(hid, u.id, "fund.contribute", undefined, undefined, { month });
  revalidatePath("/budget");
}

export async function archiveFund(fd: FormData) {
  const { hid, db } = await me();
  db.update(schema.sinkingFunds).set({ archived: true }).where(and(eq(schema.sinkingFunds.id, str(fd, "id")), eq(schema.sinkingFunds.householdId, hid))).run();
  revalidatePath("/budget");
}

// ---------------- Goals ----------------

export async function saveGoal(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const id = str(fd, "id") || newId();
    const values = {
      name: str(fd, "name"),
      type: str(fd, "type") || "savings",
      target: toCents(str(fd, "target") || "0"),
      targetDate: str(fd, "targetDate") || null,
      priority: Number(str(fd, "priority") || 10),
      linkedAccountIds: fd.getAll("linkedAccountIds").map(String).filter(Boolean),
      startingBalance: optCents(fd, "startingBalance") ?? 0,
      manualProgress: optCents(fd, "manualProgress") ?? 0,
    };
    if (!values.name || values.target <= 0) return { error: "Name and target are required." };
    const exists = db.select().from(schema.goals).where(and(eq(schema.goals.id, id), eq(schema.goals.householdId, hid))).get();
    if (exists) db.update(schema.goals).set(values).where(eq(schema.goals.id, id)).run();
    else db.insert(schema.goals).values({ id, householdId: hid, ...values }).run();
    audit(hid, u.id, exists ? "goal.update" : "goal.create", "goal", id);
    revalidatePath("/goals");
    return { ok: "Goal saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function archiveGoal(fd: FormData) {
  const { hid, db } = await me();
  db.update(schema.goals).set({ archived: true }).where(and(eq(schema.goals.id, str(fd, "id")), eq(schema.goals.householdId, hid))).run();
  revalidatePath("/goals");
}

// ---------------- Couple ----------------

export async function saveSplitPolicy(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const mode = str(fd, "mode") as "equal" | "income" | "custom";
    const byCategory: Record<string, { mode: "equal" | "income" | "custom"; shareA?: number }> = {};
    const oc = fd.getAll("overrideCategory").map(String);
    const om = fd.getAll("overrideMode").map(String);
    const os = fd.getAll("overrideShareA").map(String);
    oc.forEach((cid, i) => {
      if (!cid || !om[i]) return;
      byCategory[cid] = { mode: om[i] as "equal" | "income" | "custom", shareA: os[i] ? Number(os[i]) / 100 : undefined };
    });
    const policy = {
      default: { mode, shareA: str(fd, "shareA") ? Number(str(fd, "shareA")) / 100 : undefined },
      byCategory,
      incomeA: optCents(fd, "incomeA") ?? 0,
      incomeB: optCents(fd, "incomeB") ?? 0,
      fullyJoint: bool(fd, "fullyJoint"),
    };
    db.update(schema.households).set({ splitPolicy: policy as unknown as Record<string, unknown> }).where(eq(schema.households.id, hid)).run();
    audit(hid, u.id, "couple.policy", undefined, undefined, policy as unknown as Record<string, unknown>);
    revalidatePath("/couple");
    return { ok: "Split policy saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function recordSettlement(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const from = str(fd, "from") as "A" | "B";
    const amount = toCents(str(fd, "amount"));
    if (amount <= 0) return { error: "Enter an amount." };
    db.insert(schema.settlements).values({ id: newId(), householdId: hid, date: str(fd, "date"), from, to: from === "A" ? "B" : "A", amount, note: str(fd, "note") || null }).run();
    audit(hid, u.id, "couple.settlement", undefined, undefined, { from, amount });
    revalidatePath("/couple");
    return { ok: "Settlement recorded." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

export async function toggleMilestone(fd: FormData) {
  const { u, hid, db } = await me();
  const key = str(fd, "key");
  const existing = db.select().from(schema.mergeMilestones).where(and(eq(schema.mergeMilestones.householdId, hid), eq(schema.mergeMilestones.key, key))).get();
  if (existing) {
    db.update(schema.mergeMilestones)
      .set({ doneAt: existing.doneAt ? null : new Date().toISOString() })
      .where(and(eq(schema.mergeMilestones.householdId, hid), eq(schema.mergeMilestones.key, key)))
      .run();
  } else db.insert(schema.mergeMilestones).values({ householdId: hid, key, doneAt: new Date().toISOString() }).run();
  audit(hid, u.id, "couple.milestone", undefined, key);
  revalidatePath("/couple");
}

// ---------------- Income ----------------

export async function savePaycheck(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const id = str(fd, "id") || newId();
    const deductions = (prefix: string) =>
      fd
        .getAll(`${prefix}Label`)
        .map(String)
        .map((label, i) => ({ label, kind: String(fd.getAll(`${prefix}Kind`)[i] ?? "other"), amount: toCents(String(fd.getAll(`${prefix}Amount`)[i] || "0")) }))
        .filter((d) => d.label && d.amount > 0);
    const values = {
      owner: str(fd, "owner") as "A" | "B",
      employer: str(fd, "employer"),
      frequency: str(fd, "frequency") as "weekly" | "biweekly" | "semimonthly" | "monthly",
      gross: toCents(str(fd, "gross") || "0"),
      pretax: deductions("pre"),
      taxes: toCents(str(fd, "taxes") || "0"),
      posttax: deductions("post"),
      employerContrib: optCents(fd, "employerContrib") ?? 0,
      net: toCents(str(fd, "net") || "0"),
      depositAccountId: str(fd, "depositAccountId") || null,
    };
    if (!values.employer || values.gross <= 0) return { error: "Employer and gross pay are required." };
    const computed = values.gross - values.pretax.reduce((s, d) => s + d.amount, 0) - values.taxes - values.posttax.reduce((s, d) => s + d.amount, 0);
    const exists = db.select().from(schema.paychecks).where(and(eq(schema.paychecks.id, id), eq(schema.paychecks.householdId, hid))).get();
    if (exists) db.update(schema.paychecks).set(values).where(eq(schema.paychecks.id, id)).run();
    else db.insert(schema.paychecks).values({ id, householdId: hid, ...values }).run();
    audit(hid, u.id, "income.paycheck", "paycheck", id);
    revalidatePath("/settings/income");
    if (Math.abs(computed - values.net) > 1) {
      return { ok: `Saved, but gross minus deductions and taxes is $${(computed / 100).toFixed(2)}, not the $${(values.net / 100).toFixed(2)} net you entered. Check the stub for a missing deduction.` };
    }
    return { ok: "Paycheck saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function deletePaycheck(fd: FormData) {
  const { hid, db } = await me();
  db.update(schema.paychecks).set({ active: false }).where(and(eq(schema.paychecks.id, str(fd, "id")), eq(schema.paychecks.householdId, hid))).run();
  revalidatePath("/settings/income");
}

// ---------------- Categories ----------------

export async function saveCategory(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u, hid, db } = await me();
    const id = str(fd, "id");
    const values = {
      name: str(fd, "name"),
      group: str(fd, "group"),
      budgetType: str(fd, "budgetType"),
      essential: bool(fd, "essential"),
      isPersonalAllowance: bool(fd, "isPersonalAllowance"),
    };
    if (!values.name || !values.group) return { error: "Name and group are required." };
    if (id) db.update(schema.categories).set(values).where(and(eq(schema.categories.id, id), eq(schema.categories.householdId, hid))).run();
    else db.insert(schema.categories).values({ id: newId(), householdId: hid, ...values, isTransferLike: values.budgetType === "transfer", sortOrder: 999 }).run();
    audit(hid, u.id, "category.save", "category", id || "new");
    revalidatePath("/settings/categories");
    return { ok: "Saved." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Save failed" };
  }
}

export async function archiveCategory(fd: FormData) {
  const { hid, db } = await me();
  db.update(schema.categories).set({ archived: true }).where(and(eq(schema.categories.id, str(fd, "id")), eq(schema.categories.householdId, hid))).run();
  revalidatePath("/settings/categories");
}

// ---------------- Household / security ----------------

export async function createInviteAction(_: Result): Promise<Result> {
  const { u, hid } = await me();
  const token = createInvite(hid, u.id);
  return { ok: `/invite/${token}` };
}

export async function saveHouseholdSettings(_: Result, fd: FormData): Promise<Result> {
  const { u, hid, db } = await me();
  const hh = db.select().from(schema.households).where(eq(schema.households.id, hid)).get()!;
  const settings = (hh.settings ?? {}) as Record<string, unknown>;
  const names = (settings.partnerNames ?? {}) as Record<string, string>;
  db.update(schema.households)
    .set({
      name: str(fd, "name") || hh.name,
      timezone: str(fd, "timezone") || hh.timezone,
      settings: {
        ...settings,
        partnerNames: { A: str(fd, "nameA") || names.A, B: str(fd, "nameB") || names.B },
        lowBalanceFloor: optCents(fd, "lowBalanceFloor") ?? 50000,
        largeTxnThreshold: optCents(fd, "largeTxnThreshold") ?? 50000,
        emergencyMonths: Number(str(fd, "emergencyMonths") || 0) || undefined,
        retirement: {
          ageA: Number(str(fd, "ageA") || 0) || undefined,
          ageB: Number(str(fd, "ageB") || 0) || undefined,
          retireAge: Number(str(fd, "retireAge") || 0) || undefined,
          realReturn: str(fd, "realReturn") ? Number(str(fd, "realReturn")) / 100 : undefined,
          retirementSpend: optCents(fd, "retirementSpend") ?? undefined,
        },
      },
    })
    .where(eq(schema.households.id, hid))
    .run();
  audit(hid, u.id, "household.settings");
  revalidatePath("/", "layout");
  return { ok: "Saved." };
}

export async function startTotp(_: Result): Promise<Result> {
  const { u } = await me();
  const secret = beginTotpEnrollment(u.id);
  return { ok: secret };
}

export async function confirmTotp(_: Result, fd: FormData): Promise<Result> {
  const { u } = await me();
  return confirmTotpEnrollment(u, str(fd, "code")) ? { ok: "Two-factor authentication is on." } : { error: "That code didn't match. Try the next one." };
}

export async function changePasswordAction(_: Result, fd: FormData): Promise<Result> {
  try {
    const { u } = await me();
    await changePassword(u, str(fd, "current"), str(fd, "next"));
    return { ok: "Password changed. Other sessions were signed out." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed" };
  }
}

// ---------------- Monthly close ----------------

export async function closeMonth(fd: FormData) {
  const { u, hid, db } = await me();
  const month = str(fd, "month");
  const hh = db.select().from(schema.households).where(eq(schema.households.id, hid)).get()!;
  const mb = monthBudget(hid, month, todayIn(hh.timezone));
  const snapshot = {
    income: mb.result.income,
    fixed: { budgeted: mb.result.fixed.budgeted, spent: mb.result.fixed.spent },
    flex: { budgeted: mb.result.flex.budgeted, spent: mb.result.flex.spent },
    nonMonthly: mb.result.nonMonthly.spent,
    funds: mb.statuses.map((s) => ({ id: s.fund.id, name: s.fund.name, balance: s.balance })),
  };
  db.insert(schema.monthCloses).values({ householdId: hid, month, closedAt: new Date().toISOString(), closedBy: u.id, snapshot }).onConflictDoNothing().run();
  audit(hid, u.id, "month.close", "month", month);
  revalidatePath("/close");
}

export async function reopenMonth(fd: FormData) {
  const { u, hid, db } = await me();
  const month = str(fd, "month");
  db.delete(schema.monthCloses).where(and(eq(schema.monthCloses.householdId, hid), eq(schema.monthCloses.month, month))).run();
  audit(hid, u.id, "month.reopen", "month", month, { reason: str(fd, "reason") });
  revalidatePath("/close");
}

// ---------------- Recurring / alerts ----------------

export async function setRecurringStatus(fd: FormData) {
  const { hid, db } = await me();
  const key = str(fd, "key");
  const status = str(fd, "status") as "detected" | "confirmed" | "dismissed" | "cancelled";
  db.insert(schema.recurringSeries)
    .values({ key, householdId: hid, status, label: str(fd, "label") || null, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.recurringSeries.key, set: { status, updatedAt: new Date().toISOString() } })
    .run();
  revalidatePath("/recurring");
}

export async function markAlertsRead() {
  const { hid, db } = await me();
  db.update(schema.alerts).set({ readAt: new Date().toISOString() }).where(and(eq(schema.alerts.householdId, hid), isNull(schema.alerts.readAt))).run();
  revalidatePath("/", "layout");
}

export async function relinkTransfers() {
  const { hid } = await me();
  linkTransfers(hid, "2000-01-01");
  revalidatePath("/transactions");
}

import { and, eq } from "drizzle-orm";
import { getDb, schema, type DB } from "@/db";
import { defaultLiquidity, defaultTaxBucket } from "@/domain/accounts";
import { fetchAccounts, epochToDate, guessAccountType, parseAmountToCents, userErrors, type SfAccountSet } from "@/integrations/simplefin";
import { decrypt } from "./crypto";
import { newId } from "./crypto";
import { ingest, type IngestResult } from "./ingest";
import { audit } from "./audit";
import type { AccountType } from "@/domain/types";

export const INITIAL_HISTORY_DAYS = 90;
export const MANUAL_SYNC_COOLDOWN_MIN = 60;

export interface SyncSummary {
  accountsSeen: number;
  newAccounts: number;
  totals: IngestResult;
  errors: string[];
}

export function todayIn(tz: string, d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function upsertSnapshot(accountId: string, date: string, balance: number, db: DB = getDb()) {
  db.insert(schema.balanceSnapshots)
    .values({ accountId, date, balance })
    .onConflictDoUpdate({ target: [schema.balanceSnapshots.accountId, schema.balanceSnapshots.date], set: { balance } })
    .run();
}

/** Apply a SimpleFIN Account Set to the database. Separated from the network call for testing. */
export function applyAccountSet(householdId: string, connectionId: string, set: SfAccountSet, tz: string, db: DB = getDb()): SyncSummary {
  const summary: SyncSummary = {
    accountsSeen: set.accounts.length,
    newAccounts: 0,
    totals: { inserted: 0, updated: 0, replacedPending: 0, flaggedDuplicates: 0, transfersLinked: 0, transfersSuggested: 0 },
    errors: userErrors(set),
  };
  const conns = new Map((set.connections ?? []).map((c) => [c.conn_id, c.name]));
  const today = todayIn(tz);
  for (const a of set.accounts) {
    if (a.currency && a.currency !== "USD" && !/^https?:/.test(a.currency)) {
      summary.errors.push(`Skipped ${a.name}: currency ${a.currency} is not supported yet.`);
      continue;
    }
    const balance = parseAmountToCents(a.balance);
    let acct = db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.connectionId, connectionId), eq(schema.accounts.externalId, a.id)))
      .get();
    if (!acct) {
      const type = guessAccountType(a.name) as AccountType;
      const id = newId();
      db.insert(schema.accounts)
        .values({
          id,
          householdId,
          connectionId,
          externalId: a.id,
          name: a.name,
          institution: a.org?.name ?? (a.conn_id ? conns.get(a.conn_id) : null) ?? a.conn_name ?? null,
          type,
          owner: "joint",
          balance,
          reportedBalance: balance,
          balanceDate: epochToDate(a["balance-date"], tz),
          taxBucket: defaultTaxBucket(type),
          liquidity: defaultLiquidity(type),
        })
        .run();
      acct = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get()!;
      summary.newAccounts++;
    } else {
      db.update(schema.accounts)
        .set({ balance, reportedBalance: balance, balanceDate: epochToDate(a["balance-date"], tz) })
        .where(eq(schema.accounts.id, acct.id))
        .run();
    }
    upsertSnapshot(acct.id, today, balance, db);
    const txns = (a.transactions ?? []).map((t) => ({
      date: epochToDate(t.posted && t.posted > 0 ? t.posted : t.transacted_at ?? a["balance-date"], tz),
      amount: parseAmountToCents(t.amount),
      payee: [t.payee, t.description].filter(Boolean)[0] ?? t.memo ?? "Unknown",
      externalId: t.id,
      pending: !!t.pending,
      providerCategory: typeof t.extra?.category === "string" ? (t.extra.category as string) : null,
    }));
    const r = ingest(householdId, acct.id, "simplefin", txns, db);
    for (const k of Object.keys(r) as Array<keyof IngestResult>) summary.totals[k] += r[k];
  }
  return summary;
}

export async function syncConnection(connectionId: string, db: DB = getDb(), opts: { fetchImpl?: typeof fetch } = {}): Promise<SyncSummary> {
  const conn = db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
  if (!conn) throw new Error("Unknown connection");
  const hh = db.select().from(schema.households).where(eq(schema.households.id, conn.householdId)).get()!;
  const days = conn.lastSyncedAt ? Math.min(INITIAL_HISTORY_DAYS, Math.ceil((Date.now() - Date.parse(conn.lastSyncedAt)) / 86_400_000) + 10) : INITIAL_HISTORY_DAYS;
  const start = new Date(Date.now() - days * 86_400_000);
  try {
    const set = await fetchAccounts(decrypt(conn.accessUrlEnc), { startDate: start, pending: true }, opts.fetchImpl);
    const summary = applyAccountSet(conn.householdId, conn.id, set, hh.timezone, db);
    db.update(schema.connections)
      .set({ lastSyncedAt: new Date().toISOString(), lastError: summary.errors.length ? summary.errors.join(" | ") : null })
      .where(eq(schema.connections.id, conn.id))
      .run();
    audit(conn.householdId, null, "sync.completed", "connection", conn.id, { ...summary.totals, errors: summary.errors.length });
    return summary;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.update(schema.connections).set({ lastError: msg }).where(eq(schema.connections.id, conn.id)).run();
    throw e;
  }
}

export async function syncHousehold(householdId: string, db: DB = getDb()) {
  const conns = db.select().from(schema.connections).where(eq(schema.connections.householdId, householdId)).all();
  const results: Array<{ connectionId: string; ok: boolean; summary?: SyncSummary; error?: string }> = [];
  for (const c of conns) {
    try {
      results.push({ connectionId: c.id, ok: true, summary: await syncConnection(c.id, db) });
    } catch (e) {
      results.push({ connectionId: c.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/** Daily snapshot of every account (covers manual accounts and applies appreciation/depreciation monthly). */
export function snapshotAll(householdId: string, db: DB = getDb()) {
  const hh = db.select().from(schema.households).where(eq(schema.households.id, householdId)).get()!;
  const today = todayIn(hh.timezone);
  for (const a of db.select().from(schema.accounts).where(eq(schema.accounts.householdId, householdId)).all()) {
    upsertSnapshot(a.id, today, a.balance, db);
  }
}

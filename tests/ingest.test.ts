import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import path from "node:path";
import { openDb, schema, type DB } from "@/db";
import { seedHousehold, catId } from "@/server/seed";
import { ingest } from "@/server/ingest";
import { applyAccountSet } from "@/server/sync";
import { loadLedger } from "@/server/repo";
import { summarize } from "@/domain/ledger";
import { applyMapping, guessMapping, parseCsvText, parseOfx } from "@/integrations/fileImport";
import { claimAccessUrl, decodeSetupToken, parseAccessUrl } from "@/integrations/simplefin";
import type { SfAccountSet } from "@/integrations/simplefin";

process.env.MIGRATIONS_DIR = path.join(__dirname, "..", "drizzle");
const HH = "hh000000-test";
let db: DB;

function setup() {
  db = openDb(":memory:").db;
  db.insert(schema.households).values({ id: HH, name: "Test", timezone: "America/New_York" }).run();
  seedHousehold(HH, { A: "Matt", B: "Partner" }, db);
}

// Epoch seconds at noon ET.
const ts = (d: string) => Math.floor(Date.parse(`${d}T17:00:00Z`) / 1000);

const set1: SfAccountSet = {
  errlist: [{ code: "act.missingdata", msg: "Incomplete <b>listing</b>", account_id: "card1" }],
  connections: [{ conn_id: "C1", name: "Big Bank", org_id: "O1" }],
  accounts: [
    {
      id: "chk1", name: "Everyday Checking", conn_id: "C1", currency: "USD", balance: "4180.00", "balance-date": ts("2026-11-20"),
      transactions: [
        { id: "a1", posted: ts("2026-11-01"), amount: "3125.00", description: "ACME CORP PAYROLL" },
        { id: "a2", posted: ts("2026-11-15"), amount: "-1200.00", description: "BIG BANK CARD ONLINE PMT" },
        { id: "a3", posted: ts("2026-11-16"), amount: "-500.00", description: "TRANSFER TO SAVINGS" },
      ],
    },
    {
      id: "card1", name: "Sapphire Visa", conn_id: "C1", currency: "USD", balance: "-245.50", "balance-date": ts("2026-11-20"),
      transactions: [
        { id: "b1", posted: ts("2026-11-03"), amount: "-120.25", description: "WHOLEFDS MKT 10234" },
        { id: "b2", posted: ts("2026-11-05"), amount: "-45.25", description: "SQ *BLUE BOTTLE COFFEE OAKLAND CA" },
        { id: "b3", posted: ts("2026-11-16"), amount: "1200.00", description: "PAYMENT THANK YOU" },
        { id: "b4", posted: 0, amount: "-80.00", description: "SHELL OIL 5555", pending: true },
      ],
    },
    {
      id: "sav1", name: "High Yield Savings", conn_id: "C1", currency: "USD", balance: "15000.00", "balance-date": ts("2026-11-20"),
      transactions: [{ id: "c1", posted: ts("2026-11-17"), amount: "500.00", description: "TRANSFER FROM CHECKING" }],
    },
  ],
};

describe("SimpleFIN sync + ingest pipeline", () => {
  beforeEach(setup);

  it("creates accounts with inferred types, links transfers, and classifies correctly", () => {
    const s = applyAccountSet(HH, "conn1", set1, "America/New_York", db);
    expect(s.newAccounts).toBe(3);
    expect(s.errors).toEqual(["Incomplete blisting/b"]); // sanitized, not rendered as HTML
    const accts = db.select().from(schema.accounts).all();
    expect(Object.fromEntries(accts.map((a) => [a.name, a.type]))).toEqual({
      "Everyday Checking": "checking",
      "Sapphire Visa": "credit_card",
      "High Yield Savings": "savings",
    });
    expect(s.totals.inserted).toBe(8);
    expect(s.totals.transfersLinked).toBe(2);

    const ledger = loadLedger(HH, { start: "2026-11-01", end: "2026-11-30" }, db);
    const sum = summarize(ledger.lines);
    expect(sum.income).toBe(312500);
    // 120.25 + 45.25 posted + 80 pending gas. Card payment excluded.
    expect(sum.spending).toBe(24550);
    expect(sum.saved).toBe(50000);
    const payroll = db.select().from(schema.transactions).where(eq(schema.transactions.externalId, "a1")).get()!;
    expect(payroll.categoryId).toBe(catId(HH, "income_paychecks"));
    const coffee = db.select().from(schema.transactions).where(eq(schema.transactions.externalId, "b2")).get()!;
    expect(coffee.merchant).toBe("Blue Bottle Coffee");
    // Snapshot recorded.
    expect(db.select().from(schema.balanceSnapshots).all()).toHaveLength(3);
  });

  it("is idempotent and replaces pending with posted while keeping user edits", () => {
    applyAccountSet(HH, "conn1", set1, "America/New_York", db);
    const gas = db.select().from(schema.transactions).where(eq(schema.transactions.externalId, "b4")).get()!;
    db.update(schema.transactions).set({ categoryId: catId(HH, "transportation_gas_and_charging"), categorySource: "user" }).where(eq(schema.transactions.id, gas.id)).run();

    const set2: SfAccountSet = structuredClone(set1);
    const card = set2.accounts[1]!;
    card.transactions = card.transactions!.filter((t) => t.id !== "b4");
    card.transactions.push({ id: "b4-posted", posted: ts("2026-11-18"), amount: "-82.40", description: "SHELL OIL 55551234" });
    const s2 = applyAccountSet(HH, "conn1", set2, "America/New_York", db);
    expect(s2.totals.inserted).toBe(0);
    expect(s2.totals.replacedPending).toBe(1);
    const after = db.select().from(schema.transactions).where(eq(schema.transactions.id, gas.id)).get()!;
    expect(after.pending).toBe(false);
    expect(after.amount).toBe(-8240);
    expect(after.categoryId).toBe(catId(HH, "transportation_gas_and_charging"));
    expect(db.select().from(schema.transactions).all()).toHaveLength(8);
  });

  it("flags (does not drop) a CSV row overlapping bank data, and re-importing a CSV is a no-op", () => {
    applyAccountSet(HH, "conn1", set1, "America/New_York", db);
    const card = db.select().from(schema.accounts).where(eq(schema.accounts.externalId, "card1")).get()!;
    const csv = "Transaction Date,Description,Amount\n11/05/2026,SQ *BLUE BOTTLE COFFEE,-45.25\n11/09/2026,TARGET 00012,-33.10\n";
    const { headers, rows } = parseCsvText(csv);
    const parsed = applyMapping(rows, guessMapping(headers)).rows;
    const r1 = ingest(HH, card.id, "csv", parsed.map((p) => ({ date: p.date, amount: p.amount, payee: p.payee })), db);
    expect(r1.inserted).toBe(2);
    expect(r1.flaggedDuplicates).toBe(1);
    const r2 = ingest(HH, card.id, "csv", parsed.map((p) => ({ date: p.date, amount: p.amount, payee: p.payee })), db);
    expect(r2.inserted).toBe(0);
  });
});

describe("file parsers", () => {
  it("handles debit/credit columns, parentheses, and day-first dates", () => {
    const csv = "Date,Payee,Debit,Credit\n15/03/2026,COFFEE,4.50,\n16/03/2026,REFUND,,(10.00)\n";
    const { headers, rows } = parseCsvText(csv);
    const m = guessMapping(headers);
    expect(m.debit).toBe("Debit");
    const out = applyMapping(rows, { ...m, dateFormat: "auto" });
    expect(out.rows).toEqual([
      { date: "2026-03-15", amount: -450, payee: "COFFEE", category: undefined },
      { date: "2026-03-16", amount: 1000, payee: "REFUND", category: undefined },
    ]);
  });
  it("parses OFX", () => {
    const ofx = `<OFX><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260310120000<TRNAMT>-12.34<FITID>9001<NAME>NETFLIX</STMTTRN></OFX>`;
    expect(parseOfx(ofx)).toEqual([{ date: "2026-03-10", amount: -1234, payee: "NETFLIX", externalId: "9001" }]);
  });
});

describe("SimpleFIN client", () => {
  it("decodes the documented demo token and splits credentials out of the access URL", async () => {
    const demo = "aHR0cHM6Ly9icmlkZ2Uuc2ltcGxlZmluLm9yZy9zaW1wbGVmaW4vY2xhaW0vZGVtbw==";
    expect(decodeSetupToken(demo)).toBe("https://bridge.simplefin.org/simplefin/claim/demo");
    const fake = (async () => new Response("https://demo:demo@bridge.simplefin.org/simplefin")) as unknown as typeof fetch;
    const access = await claimAccessUrl(demo, fake);
    const p = parseAccessUrl(access);
    expect(p.base).toBe("https://bridge.simplefin.org/simplefin");
    expect(p.authHeader).toBe(`Basic ${Buffer.from("demo:demo").toString("base64")}`);
  });
  it("warns loudly on an already-claimed token", async () => {
    const f403 = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    await expect(claimAccessUrl("aHR0cHM6Ly94LnRlc3QvY2xhaW0vMQ==", f403)).rejects.toThrow(/already claimed/);
  });
});

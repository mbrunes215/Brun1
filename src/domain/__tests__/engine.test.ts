import { describe, expect, it } from "vitest";
import { allocate, addMonthsToDate, monthsBetween } from "../money";
import { cleanPayee } from "../merchant";
import { detectTransfers } from "../transfers";
import { judgeIncoming } from "../dedupe";
import { applyRules, previewRule, suggestCategory, type Rule } from "../rules";
import { accounts, C, txn } from "./fixtures";

describe("money utilities", () => {
  it("allocates with largest remainder so parts sum exactly", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(-100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-100);
    expect(allocate(10001, [0.6, 0.4])).toEqual([6001, 4000]);
  });
  it("clamps month math at month end", () => {
    expect(addMonthsToDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDate("2028-01-31", 1)).toBe("2028-02-29");
    expect(monthsBetween("2026-11", "2027-03")).toBe(4);
  });
});

describe("payee cleaning", () => {
  it.each([
    ["SQ *BLUE BOTTLE COFFEE OAKLAND CA", "Blue Bottle Coffee"],
    ["AMZN Mktp US*2K4L19XY2", "Amazon"],
    ["TST* JOES PIZZA 1234 BROOKLYN NY", "Joes Pizza"],
    ["NETFLIX.COM 866-579-7172 CA", "Netflix"],
    ["CHIPOTLE 0423", "Chipotle"],
  ])("%s -> %s", (raw, want) => {
    expect(cleanPayee(raw)).toBe(want);
  });
});

describe("transfer detection", () => {
  it("pairs a card payment and prefers the hinted, closest match", () => {
    const txns = [
      txn({ id: "o", accountId: "chkA", date: "2026-03-20", amount: -20000, payeeRaw: "CHASE CARD ONLINE PMT" }),
      txn({ id: "i", accountId: "ccA", date: "2026-03-22", amount: 20000, payeeRaw: "PAYMENT THANK YOU" }),
      txn({ id: "decoy", accountId: "hysa", date: "2026-03-24", amount: 20000, payeeRaw: "Interest" }),
    ];
    const m = detectTransfers(txns, accounts);
    expect(m).toEqual([{ outflowId: "o", inflowId: "i", confidence: "high", dayGap: 2 }]);
  });
  it("uses each transaction once when two same-amount transfers happen", () => {
    const txns = [
      txn({ id: "o1", accountId: "chkA", date: "2026-03-01", amount: -10000, payeeRaw: "Transfer to savings" }),
      txn({ id: "o2", accountId: "chkA", date: "2026-03-08", amount: -10000, payeeRaw: "Transfer to savings" }),
      txn({ id: "i1", accountId: "hysa", date: "2026-03-01", amount: 10000, payeeRaw: "Transfer from checking" }),
      txn({ id: "i2", accountId: "hysa", date: "2026-03-09", amount: 10000, payeeRaw: "Transfer from checking" }),
    ];
    const m = detectTransfers(txns, accounts);
    expect(m.map((x) => `${x.outflowId}-${x.inflowId}`).sort()).toEqual(["o1-i1", "o2-i2"]);
  });
  it("does not pair a purchase on a card with an unrelated deposit", () => {
    const txns = [
      txn({ id: "buy", accountId: "ccA", date: "2026-03-01", amount: -5000, payeeRaw: "TARGET" }),
      txn({ id: "dep", accountId: "chkB", date: "2026-03-02", amount: 5000, payeeRaw: "VENMO CASHOUT" }),
    ];
    expect(detectTransfers(txns, accounts)).toEqual([]);
  });
});

describe("dedupe / pending replacement", () => {
  const existing = [
    txn({ id: "pend", accountId: "ccA", date: "2026-03-10", amount: -4500, payeeRaw: "SHELL OIL 123", pending: true, externalId: "p-1" }),
    txn({ id: "csv", accountId: "chkA", date: "2026-03-05", amount: -2599, payeeRaw: "SPOTIFY USA" }),
  ];
  it("replaces a gas pre-auth when the final amount posts", () => {
    const inc = txn({ accountId: "ccA", date: "2026-03-11", amount: -5210, payeeRaw: "SHELL OIL 12345", externalId: "x-9" });
    expect(judgeIncoming(inc, existing)).toEqual({ kind: "replaces_pending", existingId: "pend" });
  });
  it("updates in place on same external id", () => {
    const inc = txn({ accountId: "ccA", date: "2026-03-10", amount: -4500, payeeRaw: "SHELL", externalId: "p-1" });
    expect(judgeIncoming(inc, existing)).toEqual({ kind: "update", existingId: "pend" });
  });
  it("flags (never drops) a CSV/bank overlap", () => {
    const inc = txn({ accountId: "chkA", date: "2026-03-06", amount: -2599, payeeRaw: "Spotify USA P1234", externalId: "b-7" });
    expect(judgeIncoming(inc, existing).kind).toBe("possible_duplicate");
  });
  it("treats different amounts as new", () => {
    const inc = txn({ accountId: "chkA", date: "2026-03-06", amount: -999, payeeRaw: "Spotify" });
    expect(judgeIncoming(inc, existing).kind).toBe("new");
  });
});

describe("rules engine", () => {
  const rules: Rule[] = [
    { id: "r2", priority: 2, enabled: true, conditions: { payeeContains: "costco" }, actions: { setCategoryId: C.shopping } },
    {
      id: "r1",
      priority: 1,
      enabled: true,
      conditions: { merchantEquals: "Costco", amountMin: 20000 },
      actions: { splitTemplate: [{ categoryId: C.groceries, ratio: 0.7 }, { categoryId: C.shopping, ratio: 0.3 }], addTags: ["bulk"] },
    },
    { id: "empty", priority: 0, enabled: true, conditions: {}, actions: { setCategoryId: C.dining } },
  ];
  it("first matching rule wins per field; empty rules never match", () => {
    const t = txn({ accountId: "ccA", date: "2026-03-01", amount: -30001, payeeRaw: "COSTCO WHSE #0123" });
    const p = applyRules(t, rules);
    expect(p.matchedRuleIds).toEqual(["r1", "r2"]);
    expect(p.categoryId).toBe(C.shopping);
    expect(p.splits!.map((s) => s.amount)).toEqual([-21001, -9000]);
    expect(p.splits!.reduce((s, x) => s + x.amount, 0)).toBe(-30001);
    expect(p.tags).toEqual(["bulk"]);
  });
  it("falls back to merchant memory then provider category", () => {
    const t = txn({ accountId: "ccA", date: "2026-03-01", amount: -1200, payeeRaw: "SQ *BLUE BOTTLE COFFEE" });
    const mem = new Map([["bluebottlecoffee", "food_coffee_shops"]]);
    expect(suggestCategory(t, [], mem).source).toBe("memory");
    expect(suggestCategory(t, [], new Map(), "x").source).toBe("provider");
  });
  it("previews only transactions that would change", () => {
    const ts = [
      txn({ id: "a", accountId: "ccA", date: "2026-03-01", amount: -100, payeeRaw: "COSTCO", categoryId: C.shopping }),
      txn({ id: "b", accountId: "ccA", date: "2026-03-01", amount: -100, payeeRaw: "COSTCO", categoryId: C.dining }),
    ];
    expect(previewRule(rules[0]!, ts)).toEqual([{ id: "b", from: C.dining, to: C.shopping }]);
  });
});

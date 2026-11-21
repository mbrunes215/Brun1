import { describe, expect, it } from "vitest";
import { classifyAll, makeContext, summarize, splitsBalance } from "../ledger";
import { accounts, C, categories, txn } from "./fixtures";

describe("ledger classification", () => {
  it("counts card purchases as spending and the card payment as an internal transfer", () => {
    const txns = [
      txn({ id: "p1", accountId: "ccA", date: "2026-03-03", amount: -12000, categoryId: C.groceries }),
      txn({ id: "p2", accountId: "ccA", date: "2026-03-09", amount: -8000, categoryId: C.dining }),
      txn({ id: "pay_out", accountId: "chkA", date: "2026-03-20", amount: -20000, isTransfer: true, transferPairId: "pay_in", categoryId: C.ccPayment }),
      txn({ id: "pay_in", accountId: "ccA", date: "2026-03-21", amount: 20000, isTransfer: true, transferPairId: "pay_out", categoryId: C.ccPayment }),
    ];
    const s = summarize(classifyAll(txns, makeContext(accounts, categories, txns)));
    expect(s.spending).toBe(20000); // $200, not $400
    expect(s.income).toBe(0);
    expect(s.saved).toBe(0);
  });

  it("counts a transfer to savings once, as savings, and a withdrawal as negative savings", () => {
    const txns = [
      txn({ id: "o", accountId: "chkA", date: "2026-03-01", amount: -50000, isTransfer: true, transferPairId: "i" }),
      txn({ id: "i", accountId: "hysa", date: "2026-03-02", amount: 50000, isTransfer: true, transferPairId: "o" }),
      txn({ id: "w_out", accountId: "hysa", date: "2026-03-15", amount: -10000, isTransfer: true, transferPairId: "w_in" }),
      txn({ id: "w_in", accountId: "joint", date: "2026-03-15", amount: 10000, isTransfer: true, transferPairId: "w_out" }),
    ];
    const s = summarize(classifyAll(txns, makeContext(accounts, categories, txns)));
    expect(s.saved).toBe(40000);
    expect(s.spending).toBe(0);
  });

  it("treats savings->brokerage as a pure transfer (not double-counted savings)", () => {
    const txns = [
      txn({ id: "o", accountId: "hysa", date: "2026-03-01", amount: -30000, isTransfer: true, transferPairId: "i" }),
      txn({ id: "i", accountId: "brokerage", date: "2026-03-02", amount: 30000, isTransfer: true, transferPairId: "o" }),
    ];
    const s = summarize(classifyAll(txns, makeContext(accounts, categories, txns)));
    expect(s.saved).toBe(0);
  });

  it("counts the cash leg of a linked loan payment as an expense (real monthly cost)", () => {
    const txns = [
      txn({ id: "o", accountId: "chkB", date: "2026-03-05", amount: -45000, isTransfer: true, transferPairId: "i", categoryId: C.carPayment }),
      txn({ id: "i", accountId: "auto", date: "2026-03-05", amount: 45000, isTransfer: true, transferPairId: "o" }),
    ];
    const s = summarize(classifyAll(txns, makeContext(accounts, categories, txns)));
    expect(s.spending).toBe(45000);
    expect(s.byCategory.get(C.carPayment)).toBe(-45000);
  });

  it("nets refunds against the category instead of counting them as income", () => {
    const txns = [
      txn({ accountId: "ccA", date: "2026-03-03", amount: -10000, categoryId: C.shopping }),
      txn({ accountId: "ccA", date: "2026-03-10", amount: 2500, categoryId: C.shopping }),
      txn({ accountId: "chkA", date: "2026-03-15", amount: 400000, categoryId: C.paycheck }),
    ];
    const s = summarize(classifyAll(txns, makeContext(accounts, categories)));
    expect(s.spending).toBe(7500);
    expect(s.income).toBe(400000);
    expect(s.net).toBe(392500);
  });

  it("excludes reimbursable expenses and their reimbursements", () => {
    const txns = [
      txn({ id: "trip", accountId: "ccA", date: "2026-03-03", amount: -60000, isReimbursable: true }),
      txn({ id: "back", accountId: "chkA", date: "2026-03-20", amount: 60000, reimbursementOfId: "trip" }),
    ];
    const s = summarize(classifyAll(txns, makeContext(accounts, categories)));
    expect(s.spending).toBe(0);
    expect(s.income).toBe(0);
  });

  it("classifies split lines independently and attributes owners", () => {
    const t = txn({
      accountId: "ccA",
      date: "2026-03-03",
      amount: -15000,
      splits: [
        { splitId: "a", amount: -10000, categoryId: C.groceries },
        { splitId: "b", amount: -5000, categoryId: C.funA, owner: "A" },
      ],
    });
    expect(splitsBalance(t)).toBe(true);
    const lines = classifyAll([t], makeContext(accounts, categories));
    expect(lines).toHaveLength(2);
    expect(lines[1]!.isPrivate).toBe(true);
    expect(summarize(lines).spending).toBe(15000);
  });

  it("filters by owner and ignores partner settle-ups", () => {
    const txns = [
      txn({ accountId: "chkA", date: "2026-03-03", amount: -1000, categoryId: C.dining }),
      txn({ accountId: "chkB", date: "2026-03-03", amount: -3000, categoryId: C.dining }),
      txn({ accountId: "chkB", date: "2026-03-04", amount: -5000, isSettlement: true }),
      txn({ accountId: "chkA", date: "2026-03-04", amount: 5000, isSettlement: true }),
    ];
    const lines = classifyAll(txns, makeContext(accounts, categories));
    expect(summarize(lines, { owner: "A" }).spending).toBe(1000);
    expect(summarize(lines, { owner: "B" }).spending).toBe(3000);
    expect(summarize(lines).income).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { computeMonth, computePace, derivedFlex, nextCarry, type MonthPlan } from "../budget";
import { classifyAll, makeContext } from "../ledger";
import { fundStatus, monthlySetAside, advanceDue, type SinkingFund } from "../sinkingFunds";
import { settleUp, jointShare, type SplitPolicy } from "../couple";
import { detectRecurring, priceIncrease, annualize } from "../recurring";
import { forecastAccount } from "../forecast";
import { amortizationSchedule, amortizedPayment, compareStrategies, simulatePayoff, utilization } from "../debt";
import { goalStatus, waterfall, emergencyFundTarget } from "../goals";
import { attribute, netWorth } from "../networth";
import { computedNet, monthlyIncomeModel, trueSavingsRate, type Paycheck } from "../income";
import { projectRetirement, scorecard } from "../scorecard";
import { reconcile } from "../reconcile";
import { accounts, C, categories, txn } from "./fixtures";

describe("flex budget", () => {
  const plan: MonthPlan = {
    month: "2026-03",
    expectedIncome: 900000,
    fixed: [
      { categoryId: C.rent, amount: 250000 },
      { categoryId: C.internet, amount: 8000, rollover: true },
    ],
    sinkingSetAside: 60000,
    savingsGoals: 150000,
  };
  it("derives flex as income - fixed - sinking - savings", () => {
    expect(derivedFlex(plan)).toBe(900000 - 258000 - 60000 - 150000);
  });
  it("routes spending to fixed, flex, and non-monthly buckets", () => {
    const txns = [
      txn({ accountId: "joint", date: "2026-03-01", amount: -250000, categoryId: C.rent }),
      txn({ accountId: "joint", date: "2026-03-05", amount: -7000, categoryId: C.internet }),
      txn({ accountId: "ccA", date: "2026-03-06", amount: -30000, categoryId: C.groceries }),
      txn({ accountId: "ccA", date: "2026-03-07", amount: -12000, categoryId: C.dining }),
      txn({ accountId: "ccA", date: "2026-03-08", amount: -90000, categoryId: C.autoIns }),
      txn({ accountId: "ccA", date: "2026-03-09", amount: -2000 }),
      txn({ accountId: "ccA", date: "2026-04-01", amount: -99999, categoryId: C.dining }),
    ];
    const lines = classifyAll(txns, makeContext(accounts, categories));
    const r = computeMonth(plan, lines, categories, { today: "2026-03-10", carryIn: new Map([[C.internet, 500]]) });
    expect(r.fixed.spent).toBe(257000);
    expect(r.fixed.lines.find((l) => l.categoryId === C.internet)!.remaining).toBe(8000 + 500 - 7000);
    expect(r.flex.spent).toBe(44000); // groceries + dining + uncategorized
    expect(r.uncategorizedSpent).toBe(2000);
    expect(r.nonMonthly.spent).toBe(90000); // car insurance does not hit flex
    expect(r.flex.remaining).toBe(432000 - 44000);
    expect(r.unallocated).toBe(0);
    const carry = nextCarry(plan, r);
    expect(carry.carry.get(C.internet)).toBe(1500);
    expect(carry.carry.has(C.rent)).toBe(false);
  });
  it("computes pace and safe daily spend", () => {
    // $3,100 budget, day 10 of 31: expected $1,000 by now.
    const p = computePace(310000, 150000, "2026-03", "2026-03-10")!;
    expect(p.expectedSpentByNow).toBe(100000);
    expect(p.status).toBe("over");
    expect(p.daysLeft).toBe(22);
    expect(p.perDayLeft).toBe(Math.floor(160000 / 22));
    expect(computePace(310000, 150000, "2026-03", "2026-04-01")).toBeNull();
  });
});

describe("sinking funds", () => {
  it("spreads the shortfall over the months before the due month", () => {
    // $1,200 due March, $200 saved, it is November: Nov, Dec, Jan, Feb = 4 months.
    expect(monthlySetAside(120000, 20000, "2026-11", "2027-03-15")).toBe(25000);
    expect(monthlySetAside(120000, 20000, "2027-03", "2027-03-15")).toBe(100000);
    expect(monthlySetAside(120000, 130000, "2026-11", "2027-03-15")).toBe(0);
  });
  it("rolls recurring due dates forward and reports status", () => {
    const f: SinkingFund = { id: "ins", name: "Car insurance", categoryIds: [C.autoIns], target: 120000, nextDue: "2026-03-15", recurrence: "semiannual" };
    expect(advanceDue(f, "2026-11-21")).toBe("2027-03-15");
    const ledger = [{ fundId: "ins", date: "2026-10-01", amount: 30000, kind: "contribution" as const }];
    const s = fundStatus(f, ledger, "2026-11-21");
    expect(s.monthsLeft).toBe(4);
    expect(s.setAside).toBe(22500);
    // 6-month cycle, 4 months left -> 2/6 elapsed -> $400 on-track; $300 saved -> behind.
    expect(s.onTrackBalance).toBe(40000);
    expect(s.status).toBe("behind");
  });
});

describe("couple settle-up", () => {
  const policy: SplitPolicy = { default: { mode: "income" }, incomeA: 600000, incomeB: 400000, byCategory: { [C.groceries]: { mode: "equal" } } };
  it("splits shared costs by income, honors category overrides, and nets settlements", () => {
    const txns = [
      txn({ id: "rent", accountId: "chkA", date: "2026-03-01", amount: -200000, categoryId: C.rent, isShared: true }),
      txn({ id: "groc", accountId: "chkB", date: "2026-03-03", amount: -20000, categoryId: C.groceries, isShared: true }),
      txn({ id: "mine", accountId: "chkA", date: "2026-03-04", amount: -5000, categoryId: C.dining }),
      txn({ id: "jointbill", accountId: "joint", date: "2026-03-04", amount: -8000, categoryId: C.internet, isShared: true }),
    ];
    const lines = classifyAll(txns, makeContext(accounts, categories));
    const r = settleUp(lines, policy, [{ date: "2026-03-10", from: "B", to: "A", amount: 50000 }]);
    // Rent: A pays 200,000, A's share 60% = 120,000 -> B owes 80,000.
    // Groceries: B pays 20,000, A's share 50% = 10,000 -> A owes 10,000.
    // B paid 50,000 settlement. Net: 80,000 - 10,000 - 50,000 = 20,000 (B owes A).
    expect(r.sharedTotal).toBe(220000);
    expect(r.fairShareA).toBe(130000);
    expect(r.balance).toBe(20000);
    expect(r.lines).toHaveLength(2);
  });
  it("measures the share of spending through joint accounts", () => {
    const txns = [
      txn({ accountId: "joint", date: "2026-03-01", amount: -30000, categoryId: C.groceries }),
      txn({ accountId: "chkA", date: "2026-03-01", amount: -10000, categoryId: C.dining }),
    ];
    expect(jointShare(classifyAll(txns, makeContext(accounts, categories)))).toBe(0.75);
  });
});

describe("recurring detection", () => {
  const txns = [
    ...["2026-07-03", "2026-08-03", "2026-09-03", "2026-10-03", "2026-11-03"].map((d, i) =>
      txn({ id: `n${i}`, accountId: "ccA", date: d, amount: i < 4 ? -1549 : -1799, payeeRaw: "NETFLIX.COM" }),
    ),
    ...["2026-09-04", "2026-09-18", "2026-10-02", "2026-10-16", "2026-10-30", "2026-11-13"].map((d, i) =>
      txn({ id: `p${i}`, accountId: "chkA", date: d, amount: 312500, payeeRaw: "ACME CORP PAYROLL" }),
    ),
    txn({ accountId: "ccA", date: "2026-11-02", amount: -4000, payeeRaw: "RANDOM CAFE" }),
  ];
  const series = detectRecurring(txns, "2026-11-21");
  it("detects monthly subscriptions and biweekly pay", () => {
    const nf = series.find((s) => s.merchant === "Netflix")!;
    expect(nf.cadence).toBe("monthly");
    expect(nf.nextExpected).toBe("2026-12-03");
    const pay = series.find((s) => s.direction === "inflow")!;
    expect(pay.cadence).toBe("biweekly");
    expect(pay.nextExpected).toBe("2026-11-27");
    expect(series).toHaveLength(2);
  });
  it("flags a price increase and annualizes", () => {
    const nf = series.find((s) => s.merchant === "Netflix")!;
    expect(priceIncrease(nf, txns)).toEqual({ from: 1549, to: 1799 });
    expect(annualize(-1799, "monthly")).toBe(-21588);
  });
});

describe("cash-flow forecast", () => {
  it("finds the day a bill lands before payday and dips below the floor", () => {
    const recurring = [
      { key: "rent", merchant: "Rent", accountId: "chkA", direction: "outflow" as const, cadence: "monthly" as const, typicalAmount: -250000, lastAmount: -250000, lastDate: "2026-11-01", nextExpected: "2026-12-01", occurrences: 6, amountVaries: false, txnIds: [], categoryId: null },
      { key: "pay", merchant: "Payroll", accountId: "chkA", direction: "inflow" as const, cadence: "biweekly" as const, typicalAmount: 300000, lastAmount: 300000, lastDate: "2026-11-20", nextExpected: "2026-12-04", occurrences: 6, amountVaries: false, txnIds: [], categoryId: null },
    ];
    const f = forecastAccount({ accountId: "chkA", startBalance: 300000, today: "2026-11-21", horizonDays: 30, recurring, dailyFlexSpend: 2000, floor: 50000 });
    // Nov 22..Dec 1 = 10 days of flex (20,000) then rent: 300,000 - 20,000 - 250,000 = 30,000.
    expect(f.firstBelowFloor!.date).toBe("2026-12-01");
    expect(f.firstBelowFloor!.balance).toBe(30000);
    expect(f.firstBelowFloor!.trigger!.label).toBe("Rent");
    expect(f.days.find((d) => d.date === "2026-12-04")!.balance).toBe(30000 - 6000 + 300000);
  });
});

describe("debt", () => {
  it("amortizes a loan to zero with a standard payment", () => {
    const pmt = amortizedPayment(2000000, 0.06, 60); // $20k, 6%, 5y
    expect(pmt).toBe(38666); // $386.66, matches standard tables
    const rows = amortizationSchedule(2000000, 0.06, pmt);
    expect(rows.at(-1)!.balance).toBe(0);
    expect(rows.length).toBeGreaterThanOrEqual(59);
    expect(rows.length).toBeLessThanOrEqual(61);
  });
  it("avalanche never pays more interest than snowball", () => {
    const debts = [
      { id: "card", name: "Card", balance: 500000, apr: 0.24, minPayment: 15000 },
      { id: "small", name: "Store card", balance: 80000, apr: 0.12, minPayment: 3000 },
      { id: "car", name: "Car", balance: 1200000, apr: 0.06, minPayment: 30000 },
    ];
    const c = compareStrategies(debts, 50000);
    expect(c.avalanche.totalInterest).toBeLessThanOrEqual(c.snowball.totalInterest);
    expect(c.avalanche.order[0]).toBe("card");
    expect(c.snowball.order[0]).toBe("small");
    expect(c.interestSavedVsMinimums).toBeGreaterThan(0);
    const totalPrincipal = debts.reduce((s, d) => s + d.balance, 0);
    expect(c.avalanche.totalPaid).toBe(totalPrincipal + c.avalanche.totalInterest);
  });
  it("throws when payments cannot outpace interest", () => {
    expect(() => simulatePayoff([{ id: "x", name: "x", balance: 1000000, apr: 0.3, minPayment: 1000 }], 0, "avalanche", undefined, 120)).toThrow();
  });
  it("computes utilization", () => {
    const u = utilization([{ id: "a", owed: 120000, limit: 1000000 }, { id: "b", owed: 0, limit: 500000 }]);
    expect(u.overall).toBeCloseTo(0.08);
  });
});

describe("goals", () => {
  it("reports pace vs required and ETA", () => {
    const s = goalStatus({ id: "g", name: "Down payment", type: "down_payment", target: 6000000, current: 1200000, priority: 1, targetDate: "2028-11-01", recentContributions: [150000, 200000, 250000] }, "2026-11-21");
    expect(s.requiredMonthly).toBe(200000); // 4.8M over 24 months
    expect(s.pace).toBe(200000);
    expect(s.status).toBe("on_track");
    expect(s.eta).toBe("2028-11");
  });
  it("waterfalls savings by priority", () => {
    const goals = [
      { id: "ef", name: "EF", type: "emergency_fund" as const, target: 300000, current: 250000, priority: 1 },
      { id: "trip", name: "Trip", type: "savings" as const, target: 500000, current: 0, priority: 2, targetDate: "2027-09-01" },
    ];
    const w = waterfall(goals, 100000, "2026-11-21");
    expect(w.get("ef")).toBe(50000);
    expect(w.get("trip")).toBe(50000);
  });
  it("sizes emergency fund on essential spend", () => {
    expect(emergencyFundTarget(500000, { dualIncome: true, variableIncome: false })).toEqual({ months: 3, target: 1500000 });
    expect(emergencyFundTarget(500000, { dualIncome: true, variableIncome: true }).months).toBe(6);
  });
});

describe("net worth", () => {
  it("sums with liabilities negative and breaks down by tier and owner", () => {
    const nw = netWorth(accounts);
    expect(nw.netWorth).toBe(500000 + 300000 + 200000 - 120000 + 1500000 + 4000000 - 1800000);
    expect(nw.byLiquidity.cash).toBe(1000000);
    expect(nw.byTaxBucket.taxable).toBe(4000000);
    expect(nw.byOwner.joint).toBe(1700000);
  });
  it("attribution components sum exactly to the change", () => {
    const a = (id: string) => accounts.find((x) => x.id === id)!;
    const r = attribute(
      [
        { account: a("chkA"), startBalance: 400000, endBalance: 500000, netContributions: 0 },
        { account: a("ccA"), startBalance: -100000, endBalance: -120000, netContributions: 0 },
        { account: a("brokerage"), startBalance: 3700000, endBalance: 4000000, netContributions: 100000 },
        { account: a("auto"), startBalance: -1830000, endBalance: -1800000, netContributions: 0 },
      ],
      "2026-10-01",
      "2026-10-31",
    );
    expect(r.cashFlow).toBe(80000);
    expect(r.investmentContributions).toBe(100000);
    expect(r.marketChange).toBe(200000);
    expect(r.debtPaydown).toBe(30000);
    expect(r.totalChange).toBe(100000 - 20000 + 300000 + 30000);
    expect(r.fromSaving + r.marketChange + r.valuationChange).toBe(r.totalChange);
  });
});

describe("income and savings rate", () => {
  const pc: Paycheck = {
    id: "p",
    owner: "A",
    employer: "Acme",
    frequency: "biweekly",
    gross: 400000,
    pretax: [{ label: "401k", kind: "retirement_pretax", amount: 40000 }, { label: "Medical", kind: "health", amount: 10000 }],
    taxes: 80000,
    posttax: [{ label: "Roth 401k", kind: "roth_retirement", amount: 10000 }],
    employerContrib: 16000,
    net: 260000,
  };
  it("validates the paycheck math", () => {
    expect(computedNet(pc)).toBe(260000);
  });
  it("computes a true savings rate including payroll savings and match", () => {
    const m = monthlyIncomeModel([pc]);
    expect(m.gross).toBe(866667); // 400000 * 26 / 12
    // Each deduction is monthly-ized and rounded separately: 86,667 + 21,667 + 34,667.
    expect(m.payrollSavings).toBe(143001);
    const sr = trueSavingsRate({ grossIncome: m.gross, employerContrib: m.employerContrib, payrollSavings: m.payrollSavings, cashSavings: 100000 });
    expect(sr).toBeCloseTo((143001 + 100000) / (866667 + 34667), 4);
  });
});

describe("scorecard & retirement", () => {
  it("rates metrics against benchmarks", () => {
    const m = scorecard({
      monthlyGross: 1500000,
      monthlyNet: 1000000,
      trueSavingsRate: 0.22,
      monthlyEssential: 500000,
      liquidSavings: 1700000,
      monthlyDebtPayments: 400000,
      monthlyHousing: 300000,
      monthlyFixed: 550000,
      creditUtilization: 0.12,
      netWorth: 20000000,
      netWorthChange12m: 3000000,
    });
    const by = Object.fromEntries(m.map((x) => [x.key, x.status]));
    expect(by).toEqual({ savings_rate: "good", emergency_fund: "good", dti: "ok", housing: "good", fixed_ratio: "ok", utilization: "ok", nw_income: "good" });
  });
  it("withholds spending-based ratings when history is too short to be meaningful", () => {
    const m = scorecard({
      monthlyGross: 1500000, monthlyNet: 1000000, trueSavingsRate: 0.94, monthlyEssential: 20000, liquidSavings: 1700000,
      monthlyDebtPayments: 0, monthlyHousing: 0, monthlyFixed: 0, creditUtilization: 0.05, netWorth: 100000, netWorthChange12m: null, insufficientHistory: true,
    });
    const by = Object.fromEntries(m.map((x) => [x.key, x.status]));
    expect(by.savings_rate).toBe("unknown");
    expect(by.emergency_fund).toBe("unknown");
    expect(by.utilization).toBe("good"); // balance-based metrics still apply
  });
  it("projects FI with the 4% rule", () => {
    const r = projectRetirement({ currentInvested: 10000000, annualContribution: 3000000, annualSpendInRetirement: 8000000, yearsToRetirement: 25, realReturn: 0.05 });
    expect(r.fiNumber).toBe(200000000);
    expect(r.path).toHaveLength(25);
    expect(r.yearsToFI).not.toBeNull();
    // Required contribution reaches FI exactly in 25 years.
    const check = projectRetirement({ currentInvested: 10000000, annualContribution: r.requiredAnnualContribution, annualSpendInRetirement: 8000000, yearsToRetirement: 25, realReturn: 0.05 });
    expect(Math.abs(check.projectedAtRetirement - r.fiNumber)).toBeLessThan(200);
  });
});

describe("reconciliation", () => {
  it("finds a missing transaction equal to the drift", () => {
    const txns = [
      txn({ id: "a", accountId: "chkA", date: "2026-03-02", amount: -5000 }),
      txn({ id: "dup", accountId: "chkA", date: "2026-03-03", amount: -1234 }),
      txn({ id: "dup2", accountId: "chkA", date: "2026-03-03", amount: -1234 }),
    ];
    const r = reconcile({ anchorBalance: 100000, anchorDate: "2026-03-01", reportedBalance: 100000 - 5000 - 1234, txns });
    expect(r.ok).toBe(false);
    expect(r.drift).toBe(1234);
    expect(r.suspects.map((t) => t.id)).toEqual(["dup", "dup2"]);
  });
});

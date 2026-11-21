import { and, asc, eq, gte, lte } from "drizzle-orm";
import { getDb, schema, type DB } from "@/db";
import { addDays, addMonths, monthEnd, monthKey, monthStart } from "@/domain/money";
import { computeMonth, derivedFlex, type MonthPlan } from "@/domain/budget";
import { categorySpend, summarize, type ClassifiedLine, type OwnerFilter } from "@/domain/ledger";
import { fundStatus, drawsFromSpending, type FundLedgerEntry, type SinkingFund } from "@/domain/sinkingFunds";
import { netWorth, attribute, type AccountPeriod } from "@/domain/networth";
import { INSTALLMENT_DEBT, defaultLiquidity, isLiability, liquidity } from "@/domain/accounts";
import { detectRecurring, monthlyEquivalent, type RecurringSeries } from "@/domain/recurring";
import { monthlyIncomeModel, trueSavingsRate, type Paycheck } from "@/domain/income";
import { scorecard } from "@/domain/scorecard";
import { utilization } from "@/domain/debt";
import { settleUp, jointShare, type Settlement } from "@/domain/couple";
import { forecastAccount } from "@/domain/forecast";
import type { Account, Category } from "@/domain/types";
import { getHousehold, loadAccounts, loadLedger, toAccount, toCategory, loadCategories, loadTxnRows, toTxn } from "./repo";

// ---------------- Budget ----------------

export function loadPlan(householdId: string, month: string, db: DB = getDb()) {
  const bm = db
    .select()
    .from(schema.budgetMonths)
    .where(and(eq(schema.budgetMonths.householdId, householdId), eq(schema.budgetMonths.month, month)))
    .get();
  const lines = bm ? db.select().from(schema.budgetLines).where(eq(schema.budgetLines.budgetMonthId, bm.id)).all() : [];
  return { bm, lines };
}

export function loadFunds(householdId: string, db: DB = getDb()): { funds: SinkingFund[]; ledger: FundLedgerEntry[] } {
  const rows = db.select().from(schema.sinkingFunds).where(and(eq(schema.sinkingFunds.householdId, householdId), eq(schema.sinkingFunds.archived, false))).all();
  const funds: SinkingFund[] = rows.map((r) => ({ id: r.id, name: r.name, categoryIds: r.categoryIds, target: r.target, nextDue: r.nextDue, recurrence: r.recurrence, backingAccountId: r.backingAccountId }));
  const ledger: FundLedgerEntry[] = [];
  for (const f of funds) {
    for (const e of db.select().from(schema.sinkingFundLedger).where(eq(schema.sinkingFundLedger.fundId, f.id)).all()) {
      ledger.push({ fundId: e.fundId, date: e.date, amount: e.amount, kind: e.kind, txnId: e.txnId ?? undefined });
    }
  }
  return { funds, ledger };
}

/** Fund ledger = recorded contributions/adjustments + draws derived live from categorized spending. */
export function fundLedgerWithDraws(funds: SinkingFund[], stored: FundLedgerEntry[], lines: ClassifiedLine[]): FundLedgerEntry[] {
  const contributions = stored.filter((e) => e.kind !== "draw");
  const draws = drawsFromSpending(
    funds,
    lines.filter((l) => l.kind === "expense").map((l) => ({ txnId: l.txnId, date: l.date, categoryId: l.categoryId, amount: l.amount })),
  );
  return [...contributions, ...draws];
}

export function monthBudget(householdId: string, month: string, today: string, view: OwnerFilter = "household", db: DB = getDb()) {
  const { bm, lines: blines } = loadPlan(householdId, month, db);
  const ledger = loadLedger(householdId, { start: addDays(monthStart(month), -400), end: monthEnd(month) }, db);
  const viewLines = view === "household" ? ledger.lines : ledger.lines.filter((l) => l.owner === view);
  const cats = new Map(ledger.categories.map((c) => [c.id, c]));
  const { funds, ledger: stored } = loadFunds(householdId, db);
  const fundLedger = fundLedgerWithDraws(funds, stored, ledger.lines);
  const asOf = today < monthEnd(month) ? today : monthEnd(month);
  const statuses = funds.map((f) => fundStatus(f, fundLedger, asOf));
  const sinkingSetAside = statuses.reduce((s, f) => s + f.setAside, 0);

  const plan: MonthPlan = {
    month,
    expectedIncome: bm?.expectedIncome ?? 0,
    fixed: blines.filter((l) => cats.get(l.categoryId)?.budgetType === "fixed").map((l) => ({ categoryId: l.categoryId, amount: l.amount, rollover: l.rollover })),
    flexLines: blines.filter((l) => cats.get(l.categoryId)?.budgetType === "flex").map((l) => ({ categoryId: l.categoryId, amount: l.amount, rollover: l.rollover })),
    flexTotal: bm?.flexTotal ?? null,
    sinkingSetAside,
    savingsGoals: bm?.savingsGoals ?? 0,
    flexRollover: bm?.flexRollover ?? false,
  };

  // Rollover carry from the prior month (one level; enough for monthly use).
  const prev = addMonths(month, -1);
  const prevPlan = loadPlan(householdId, prev, db);
  const carryIn = new Map<string, number>();
  let flexCarryIn = 0;
  if (prevPlan.bm) {
    const prevSpend = categorySpend(viewLines.filter((l) => monthKey(l.date) === prev));
    for (const l of prevPlan.lines) if (l.rollover) carryIn.set(l.categoryId, l.amount - (prevSpend.get(l.categoryId) ?? 0));
    if (prevPlan.bm.flexRollover && prevPlan.bm.flexTotal != null) {
      let prevFlex = 0;
      for (const [cid, amt] of prevSpend) if (!cid || (cats.get(cid)?.budgetType ?? "flex") === "flex") prevFlex += amt;
      flexCarryIn = prevPlan.bm.flexTotal - prevFlex;
    }
  }
  const result = computeMonth(plan, viewLines, ledger.categories, { today, carryIn, flexCarryIn });
  return { plan, result, statuses, hasPlan: !!bm, categories: ledger.categories, derivedFlex: derivedFlex(plan), ledger };
}

// ---------------- Net worth ----------------

export function netWorthHistory(householdId: string, months = 12, db: DB = getDb()) {
  const accounts = loadAccounts(householdId, db).filter((a) => !a.isHidden);
  const ids = new Set(accounts.map((a) => a.id));
  const snaps = db.select().from(schema.balanceSnapshots).orderBy(asc(schema.balanceSnapshots.date)).all().filter((s) => ids.has(s.accountId));
  const byAcct = new Map<string, Array<{ date: string; balance: number }>>();
  for (const s of snaps) (byAcct.get(s.accountId) ?? byAcct.set(s.accountId, []).get(s.accountId)!).push(s);
  const balanceAt = (acctId: string, date: string, fallback: number): number => {
    const arr = byAcct.get(acctId);
    if (!arr?.length) return fallback;
    let v: number | null = null;
    for (const s of arr) {
      if (s.date <= date) v = s.balance;
      else break;
    }
    return v ?? 0; // before the first snapshot the account didn't exist for us
  };
  const now = new Date().toISOString().slice(0, 10);
  const points: Array<{ month: string; date: string; assets: number; liabilities: number; netWorth: number }> = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = addMonths(monthKey(now), -i);
    const date = i === 0 ? now : monthEnd(m);
    let assets = 0;
    let liabilities = 0;
    for (const a of accounts) {
      const b = balanceAt(a.id, date, i === 0 ? a.balance : 0);
      if (isLiability(toAccount(a))) liabilities += b;
      else assets += b;
    }
    points.push({ month: m, date, assets, liabilities, netWorth: assets + liabilities });
  }
  /** Balance at `date`, or the first known balance if tracking started later (an opening balance, not a change). */
  const openingAt = (acctId: string, date: string, fallback: number): number => {
    const arr = byAcct.get(acctId);
    if (!arr?.length) return fallback;
    return arr[0]!.date > date ? arr[0]!.balance : balanceAt(acctId, date, fallback);
  };
  return { points, balanceAt, openingAt, accounts };
}

export function netWorthAttribution(householdId: string, start: string, end: string, db: DB = getDb()) {
  const { balanceAt, openingAt, accounts } = netWorthHistory(householdId, 13, db);
  const rows = loadTxnRows(householdId, { start: addDays(start, 1), end }, db);
  const periods: AccountPeriod[] = accounts.map((a) => {
    const acct = toAccount(a);
    const tier = liquidity(acct);
    let netContributions = 0;
    if (tier === "invested" || tier === "retirement") {
      // Contributions = transfers in/out and payroll deposits; everything else (dividends, gains) is market.
      for (const r of rows) if (r.accountId === a.id && (r.isTransfer || /contribution|deposit|transfer|payroll|employer/i.test(r.payeeRaw))) netContributions += r.amount;
    }
    return { account: acct, startBalance: openingAt(a.id, start, a.balance), endBalance: balanceAt(a.id, end, a.balance), netContributions };
  });
  return attribute(periods, start, end);
}

// ---------------- Income / scorecard ----------------

export function loadPaychecks(householdId: string, db: DB = getDb()): Paycheck[] {
  return db
    .select()
    .from(schema.paychecks)
    .where(and(eq(schema.paychecks.householdId, householdId), eq(schema.paychecks.active, true)))
    .all()
    .map((p) => ({ ...p, pretax: p.pretax as Paycheck["pretax"], posttax: p.posttax as Paycheck["posttax"] }));
}

export function trailing(lines: ClassifiedLine[], today: string, months: number) {
  const end = monthEnd(addMonths(monthKey(today), -1));
  const start = monthStart(addMonths(monthKey(today), -months));
  const s = summarize(lines, { start, end });
  const n = months;
  return { start, end, income: Math.round(s.income / n), spending: Math.round(s.spending / n), saved: Math.round(s.saved / n), byCategory: s.byCategory };
}

export function essentialMonthly(byCategory: Map<string | null, number>, cats: Map<string, Category>, months = 1): number {
  let total = 0;
  for (const [cid, amt] of byCategory) {
    if (!cid) continue;
    const c = cats.get(cid);
    if (c && c.essential && (c.budgetType === "fixed" || c.budgetType === "flex" || c.budgetType === "non_monthly")) total += -amt;
  }
  return Math.round(total / months);
}

export function healthScorecard(householdId: string, today: string, db: DB = getDb()) {
  const ledger = loadLedger(householdId, { start: monthStart(addMonths(monthKey(today), -13)), end: today }, db);
  const cats = new Map(ledger.categories.map((c) => [c.id, c]));
  // Average over the complete months we actually have data for (up to 3), not a fixed 3.
  const t3full = trailing(ledger.lines, today, 3);
  const covered = new Set(ledger.lines.filter((l) => l.kind === "expense" && l.date >= t3full.start && l.date <= t3full.end).map((l) => l.date.slice(0, 7))).size;
  const n = Math.max(1, covered);
  const t3sum = summarize(ledger.lines, { start: t3full.start, end: t3full.end });
  const t3 = { ...t3full, income: Math.round(t3sum.income / n), spending: Math.round(t3sum.spending / n), saved: Math.round(t3sum.saved / n) };
  const essential = essentialMonthly(t3sum.byCategory, cats, n);
  const paychecks = loadPaychecks(householdId, db);
  const model = monthlyIncomeModel(paychecks);
  const accts = ledger.accounts.filter((a) => !a.isHidden);
  const nw = netWorth(accts);
  const cardsOwed = accts.filter((a) => a.type === "credit_card").reduce((s, a) => s + Math.max(0, -a.balance), 0);
  // Sinking-fund money is earmarked for known bills, so it isn't emergency money.
  const { funds, ledger: fundStored } = loadFunds(householdId, db);
  const earmarked = funds.length ? fundLedgerWithDraws(funds, fundStored, ledger.lines).reduce((sum, e) => sum + e.amount, 0) : 0;
  const liquid = nw.byLiquidity.cash + nw.byLiquidity.near_cash - cardsOwed - Math.max(0, earmarked);
  let fixed = 0;
  let housing = 0;
  let debtPay = 0;
  for (const [cid, amt] of t3sum.byCategory) {
    const c = cid ? cats.get(cid) : undefined;
    if (!c) continue;
    const spent = -amt / n;
    if (c.budgetType === "fixed") fixed += spent;
    if (c.group === "Housing" && c.budgetType === "fixed") housing += spent;
    if (c.group === "Debt payments" || /mortgage|car payment|loan/i.test(c.name)) debtPay += spent;
  }
  // Add credit card minimums for carried balances.
  for (const a of accts) if (a.type === "credit_card" && a.minPayment) debtPay += a.minPayment;
  const util = utilization(accts.filter((a) => a.type === "credit_card").map((a) => ({ id: a.id, owed: -a.balance, limit: a.creditLimit })));
  const hist = netWorthHistory(householdId, 13, db).points;
  const nwChange = hist.length >= 13 && hist[0]!.netWorth !== 0 ? hist[12]!.netWorth - hist[0]!.netWorth : null;
  const gross = model.gross || t3.income; // fall back to observed net income if no paycheck model
  const sr = model.gross
    ? trueSavingsRate({ grossIncome: model.gross, employerContrib: model.employerContrib, payrollSavings: model.payrollSavings, cashSavings: Math.max(0, t3.income - t3.spending) })
    : t3.income > 0
      ? (t3.income - t3.spending) / t3.income
      : null;
  const metrics = scorecard({
    monthlyGross: gross,
    monthlyNet: model.net || t3.income,
    trueSavingsRate: sr,
    monthlyEssential: essential,
    liquidSavings: liquid,
    monthlyDebtPayments: Math.round(debtPay),
    monthlyHousing: Math.round(housing),
    monthlyFixed: Math.round(fixed),
    creditUtilization: util.overall,
    netWorth: nw.netWorth,
    netWorthChange12m: nwChange,
    insufficientHistory: covered < 2,
  });
  // Money actually invested each month (trailing 3 months). Retirement-account deposits are skipped when a
  // paycheck model exists, because payroll contributions are already counted there.
  const acctById = new Map(accts.map((a) => [a.id, a]));
  let invested = 0;
  for (const l of ledger.lines) {
    if (l.kind !== "savings" || l.date < t3.start || l.date > t3.end) continue;
    const a = acctById.get(l.accountId);
    if (!a) continue;
    const tier = a.liquidity ?? defaultLiquidity(a.type);
    if (tier === "invested" || (tier === "retirement" && !model.gross)) invested += l.saved;
  }
  const investedMonthly = Math.round(invested / n) + model.payrollSavings;
  return { metrics, essential, model, trailing3: t3, monthsOfHistory: covered, nw, liquid, earmarked: Math.max(0, earmarked), savingsRateIsTrue: model.gross > 0, investedMonthly };
}

// ---------------- Recurring ----------------

export function recurringSeries(householdId: string, today: string, db: DB = getDb()) {
  const rows = loadTxnRows(householdId, { start: addDays(today, -400) }, db);
  const series = detectRecurring(rows.map((r) => toTxn(r)), today);
  const states = new Map(db.select().from(schema.recurringSeries).where(eq(schema.recurringSeries.householdId, householdId)).all().map((s) => [s.key, s]));
  const cats = new Map(loadCategories(householdId, db).map((c) => [c.id, c]));
  return series
    .map((s) => ({ ...s, status: states.get(s.key)?.status ?? "detected", label: states.get(s.key)?.label ?? s.merchant }))
    .filter((s) => s.status !== "dismissed")
    // A weekly coffee or monthly Sephora run is a habit, not a bill: discretionary
    // categories with varying amounts are excluded unless the user confirmed them.
    .filter((s) => {
      if (s.status === "confirmed" || s.direction === "inflow") return true;
      const bt = s.categoryId ? cats.get(s.categoryId)?.budgetType : undefined;
      const discretionary = bt === "flex" || bt === undefined || cats.get(s.categoryId ?? "")?.isPersonalAllowance;
      return !(discretionary && s.amountVaries);
    });
}

export function subscriptionsAnnual(series: Array<RecurringSeries & { status: string }>): number {
  return series.filter((s) => s.direction === "outflow" && s.status !== "cancelled").reduce((sum, s) => sum + monthlyEquivalent(-s.typicalAmount, s.cadence) * 12, 0);
}

// ---------------- Couple ----------------

export function loadSettlements(householdId: string, db: DB = getDb()): Settlement[] {
  return db
    .select()
    .from(schema.settlements)
    .where(eq(schema.settlements.householdId, householdId))
    .all()
    .map((s) => ({ date: s.date, from: s.from, to: s.to, amount: s.amount, txnId: s.txnId ?? undefined }));
}

export function coupleSummary(householdId: string, today: string, db: DB = getDb()) {
  const hh = getHousehold(householdId, db);
  const paychecks = loadPaychecks(householdId, db);
  const incA = monthlyIncomeModel(paychecks.filter((p) => p.owner === "A"));
  const incB = monthlyIncomeModel(paychecks.filter((p) => p.owner === "B"));
  const policy = { ...hh.policy, incomeA: hh.policy.incomeA || incA.net, incomeB: hh.policy.incomeB || incB.net };
  const ledger = loadLedger(householdId, {}, db);
  const settlements = loadSettlements(householdId, db);
  const all = settleUp(ledger.lines, policy, settlements);
  const m = monthKey(today);
  const thisMonth = settleUp(ledger.lines, policy, settlements, { start: monthStart(m), end: monthEnd(m) });
  const jointTrend: Array<{ month: string; share: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const mm = addMonths(m, -i);
    jointTrend.push({ month: mm, share: jointShare(ledger.lines, { start: monthStart(mm), end: monthEnd(mm) }) });
  }
  return { policy, rawPolicy: hh.policy, all, thisMonth, jointTrend, names: hh.names, ledger };
}

// ---------------- Forecast ----------------

export function cashForecast(householdId: string, today: string, horizon = 60, db: DB = getDb()) {
  const hh = getHousehold(householdId, db);
  const accounts = loadAccounts(householdId, db).filter((a) => a.type === "checking" && !a.isHidden);
  const series = recurringSeries(householdId, today, db).filter((s) => s.status !== "cancelled");
  const ledger = loadLedger(householdId, { start: addDays(today, -90), end: today }, db);
  const cats = new Map(ledger.categories.map((c) => [c.id, c]));
  const recurringIds = new Set(series.flatMap((s) => s.txnIds));
  // Average daily non-recurring flexible spend by account over 90 days (card spend hits checking via card payments).
  const flexByAcct = new Map<string, number>();
  for (const l of ledger.lines) {
    if (l.kind !== "expense" || recurringIds.has(l.txnId)) continue;
    const bt = l.categoryId ? cats.get(l.categoryId)?.budgetType : "flex";
    if (bt === "non_monthly") continue;
    flexByAcct.set(l.accountId, (flexByAcct.get(l.accountId) ?? 0) - l.amount);
  }
  // Card payments are recurring-ish; attribute card spend to the checking account that pays the card.
  const cardSpend = [...flexByAcct.entries()].filter(([id]) => ledger.accounts.find((a) => a.id === id)?.type === "credit_card").reduce((s, [, v]) => s + v, 0);
  const floor = (hh.settings.lowBalanceFloor as number | undefined) ?? 50000;
  return accounts.map((a) => {
    const own = flexByAcct.get(a.id) ?? 0;
    const share = accounts.length ? cardSpend / accounts.length : 0;
    const daily = Math.round((own + share) / 90);
    return {
      account: a,
      daily,
      result: forecastAccount({ accountId: a.id, startBalance: a.balance, today, horizonDays: horizon, recurring: series, dailyFlexSpend: daily, floor }),
      floor,
    };
  });
}

export { toCategory, loadCategories, INSTALLMENT_DEBT };
export type { Account };

import type { Cents } from "./types";

/**
 * Financial health scorecard. Benchmarks are widely used rules of thumb, not
 * personalized advice; the UI labels them that way.
 */

export type MetricStatus = "good" | "ok" | "attention" | "unknown";

export interface Metric {
  key: string;
  label: string;
  value: number | null;
  display: string;
  benchmark: string;
  status: MetricStatus;
  explain: string;
}

export interface ScorecardInputs {
  monthlyGross: Cents;
  monthlyNet: Cents;
  trueSavingsRate: number | null;
  monthlyEssential: Cents;
  liquidSavings: Cents; // cash + near cash, minus any credit card balances you'd pay off
  monthlyDebtPayments: Cents; // all required debt payments incl. mortgage
  monthlyHousing: Cents; // rent or PITI + HOA
  monthlyFixed: Cents;
  creditUtilization: number | null;
  netWorth: Cents;
  netWorthChange12m: Cents | null;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function scorecard(i: ScorecardInputs): Metric[] {
  const m: Metric[] = [];

  const sr = i.trueSavingsRate;
  m.push({
    key: "savings_rate",
    label: "Savings rate",
    value: sr,
    display: sr == null ? "—" : pct(sr),
    benchmark: "15–20%+ of gross",
    status: sr == null ? "unknown" : sr >= 0.15 ? "good" : sr >= 0.1 ? "ok" : "attention",
    explain: "Everything you save (incl. pre-tax 401k/HSA and employer match) divided by gross income.",
  });

  const ef = i.monthlyEssential > 0 ? i.liquidSavings / i.monthlyEssential : null;
  m.push({
    key: "emergency_fund",
    label: "Emergency fund",
    value: ef,
    display: ef == null ? "—" : `${ef.toFixed(1)} mo`,
    benchmark: "3–6 months of essentials",
    status: ef == null ? "unknown" : ef >= 3 ? "good" : ef >= 1 ? "ok" : "attention",
    explain: "Cash and savings divided by monthly essential spending (fixed costs plus essentials like groceries).",
  });

  const dti = i.monthlyGross > 0 ? i.monthlyDebtPayments / i.monthlyGross : null;
  m.push({
    key: "dti",
    label: "Debt-to-income",
    value: dti,
    display: dti == null ? "—" : pct(dti),
    benchmark: "≤ 36% (lenders' common cap)",
    status: dti == null ? "unknown" : dti <= 0.2 ? "good" : dti <= 0.36 ? "ok" : "attention",
    explain: "Required monthly debt payments (incl. mortgage) divided by gross monthly income.",
  });

  const housing = i.monthlyGross > 0 ? i.monthlyHousing / i.monthlyGross : null;
  m.push({
    key: "housing",
    label: "Housing ratio",
    value: housing,
    display: housing == null ? "—" : pct(housing),
    benchmark: "≤ 28% of gross",
    status: housing == null ? "unknown" : housing <= 0.25 ? "good" : housing <= 0.28 ? "ok" : "attention",
    explain: "Rent or mortgage (principal, interest, taxes, insurance, HOA) divided by gross income.",
  });

  const fixed = i.monthlyNet > 0 ? i.monthlyFixed / i.monthlyNet : null;
  m.push({
    key: "fixed_ratio",
    label: "Fixed costs",
    value: fixed,
    display: fixed == null ? "—" : pct(fixed),
    benchmark: "≤ 50–60% of take-home",
    status: fixed == null ? "unknown" : fixed <= 0.5 ? "good" : fixed <= 0.6 ? "ok" : "attention",
    explain: "Bills you can't easily cut, as a share of take-home pay. Lower = more resilient to a job loss.",
  });

  const u = i.creditUtilization;
  m.push({
    key: "utilization",
    label: "Credit utilization",
    value: u,
    display: u == null ? "—" : pct(u),
    benchmark: "< 30%, ideally < 10%",
    status: u == null ? "unknown" : u < 0.1 ? "good" : u < 0.3 ? "ok" : "attention",
    explain: "Card balances divided by credit limits. A major credit score factor.",
  });

  const annual = i.monthlyGross * 12;
  const nwRatio = annual > 0 ? i.netWorth / annual : null;
  m.push({
    key: "nw_income",
    label: "Net worth ÷ income",
    value: nwRatio,
    display: nwRatio == null ? "—" : `${nwRatio.toFixed(1)}×`,
    benchmark: "Rises with age; trend matters most",
    status:
      i.netWorthChange12m == null ? "unknown" : i.netWorthChange12m > 0 ? "good" : i.netWorthChange12m === 0 ? "ok" : "attention",
    explain: "Net worth as a multiple of annual gross income. Status reflects the 12-month trend.",
  });

  return m;
}

// ---------------- Retirement / FI projection ----------------

export interface RetirementInputs {
  currentInvested: Cents;
  annualContribution: Cents;
  annualSpendInRetirement: Cents; // today's dollars
  yearsToRetirement: number;
  realReturn: number; // after inflation, e.g. 0.05
  withdrawalRate?: number; // default 0.04
}

export interface RetirementProjection {
  fiNumber: Cents;
  projectedAtRetirement: Cents;
  fundedRatio: number;
  yearsToFI: number | null;
  path: Cents[]; // year-end balances, today's dollars
  requiredAnnualContribution: Cents;
}

export function projectRetirement(i: RetirementInputs): RetirementProjection {
  const wr = i.withdrawalRate ?? 0.04;
  const fi = Math.round(i.annualSpendInRetirement / wr);
  const path: Cents[] = [];
  let bal = i.currentInvested;
  let yearsToFI: number | null = bal >= fi ? 0 : null;
  for (let y = 1; y <= Math.max(i.yearsToRetirement, 60); y++) {
    bal = Math.round(bal * (1 + i.realReturn) + i.annualContribution);
    if (y <= i.yearsToRetirement) path.push(bal);
    if (yearsToFI === null && bal >= fi) yearsToFI = y;
    if (y >= i.yearsToRetirement && yearsToFI !== null) break;
  }
  const projected = path.length ? path[path.length - 1]! : i.currentInvested;
  // Contribution needed to reach FI exactly at retirement (future value of annuity).
  const n = i.yearsToRetirement;
  const r = i.realReturn;
  const growth = Math.pow(1 + r, n);
  const needed = n <= 0 ? Math.max(0, fi - i.currentInvested) : r === 0 ? (fi - i.currentInvested) / n : ((fi - i.currentInvested * growth) * r) / (growth - 1);
  return {
    fiNumber: fi,
    projectedAtRetirement: projected,
    fundedRatio: fi > 0 ? projected / fi : 1,
    yearsToFI,
    path,
    requiredAnnualContribution: Math.max(0, Math.round(needed)),
  };
}

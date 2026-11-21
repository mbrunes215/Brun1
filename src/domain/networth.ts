import { INSTALLMENT_DEBT, isLiability, liquidity, taxBucket } from "./accounts";
import type { Account, Cents, ISODate, LiquidityTier, Owner, TaxBucket } from "./types";

export interface NetWorthBreakdown {
  assets: Cents;
  liabilities: Cents; // negative
  netWorth: Cents;
  byLiquidity: Record<LiquidityTier, Cents>;
  byTaxBucket: Record<TaxBucket, Cents>;
  byOwner: Record<Owner, Cents>;
}

export function netWorth(accounts: Account[]): NetWorthBreakdown {
  const byLiquidity: Record<LiquidityTier, Cents> = { cash: 0, near_cash: 0, invested: 0, retirement: 0, illiquid: 0, liability: 0 };
  const byTaxBucket: Record<TaxBucket, Cents> = { taxable: 0, tax_deferred: 0, tax_free: 0, hsa: 0, education: 0, none: 0 };
  const byOwner: Record<Owner, Cents> = { A: 0, B: 0, joint: 0 };
  let assets = 0;
  let liabilities = 0;
  for (const a of accounts) {
    if (a.isHidden) continue;
    if (isLiability(a)) liabilities += a.balance;
    else assets += a.balance;
    byLiquidity[liquidity(a)] += a.balance;
    if (!isLiability(a)) byTaxBucket[taxBucket(a)] += a.balance;
    byOwner[a.owner] += a.balance;
  }
  return { assets, liabilities, netWorth: assets + liabilities, byLiquidity, byTaxBucket, byOwner };
}

export interface AccountPeriod {
  account: Account;
  startBalance: Cents;
  endBalance: Cents;
  /** Net money moved in from other accounts or payroll (contributions - withdrawals) during the period. */
  netContributions: Cents;
}

export interface Attribution {
  start: ISODate;
  end: ISODate;
  totalChange: Cents;
  /** Change in cash accounts and credit cards: what day-to-day cash flow added/removed. */
  cashFlow: Cents;
  /** New money put into investment/retirement accounts. */
  investmentContributions: Cents;
  /** Investment change not explained by contributions: market gains/losses, dividends, fees. */
  marketChange: Cents;
  /** Principal paid down on installment debt (positive) net of new borrowing. */
  debtPaydown: Cents;
  /** Changes in home/vehicle/other asset valuations. */
  valuationChange: Cents;
  /** cashFlow + investmentContributions + debtPaydown. "What we did" vs "what markets did". */
  fromSaving: Cents;
}

/**
 * Split a period's net-worth change into what you did (saving, paying down
 * debt) versus what markets and valuations did. Components sum exactly to the
 * total change.
 */
export function attribute(periods: AccountPeriod[], start: ISODate, end: ISODate): Attribution {
  let cashFlow = 0;
  let contrib = 0;
  let market = 0;
  let debt = 0;
  let valuation = 0;
  for (const p of periods) {
    if (p.account.isHidden) continue;
    const change = p.endBalance - p.startBalance;
    const t = p.account.type;
    const tier = liquidity(p.account);
    if (INSTALLMENT_DEBT.has(t)) debt += change;
    else if (t === "credit_card" || tier === "cash" || tier === "near_cash") cashFlow += change;
    else if (tier === "invested" || tier === "retirement") {
      contrib += p.netContributions;
      market += change - p.netContributions;
    } else valuation += change;
  }
  const totalChange = cashFlow + contrib + market + debt + valuation;
  return {
    start,
    end,
    totalChange,
    cashFlow,
    investmentContributions: contrib,
    marketChange: market,
    debtPaydown: debt,
    valuationChange: valuation,
    fromSaving: cashFlow + contrib + debt,
  };
}

/** Straight-line-ish declining balance depreciation for vehicles. */
export function depreciate(value: Cents, annualRate: number, months: number): Cents {
  return Math.round(value * Math.pow(1 - annualRate, months / 12));
}

/** Appreciation at an annual rate. */
export function appreciate(value: Cents, annualRate: number, months: number): Cents {
  return Math.round(value * Math.pow(1 + annualRate, months / 12));
}

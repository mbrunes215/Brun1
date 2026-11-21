import type { Account, AccountType, LiquidityTier, TaxBucket } from "./types";

export const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set([
  "credit_card",
  "mortgage",
  "heloc",
  "auto_loan",
  "student_loan",
  "personal_loan",
  "other_liability",
]);

export const INSTALLMENT_DEBT: ReadonlySet<AccountType> = new Set([
  "mortgage",
  "heloc",
  "auto_loan",
  "student_loan",
  "personal_loan",
  "other_liability",
]);

/** Accounts where money moved in counts as household savings (not spending). */
export const SAVINGS_DESTINATIONS: ReadonlySet<AccountType> = new Set([
  "savings",
  "cd",
  "brokerage",
  "retirement_401k",
  "ira",
  "roth_ira",
  "hsa",
  "education_529",
  "crypto",
]);

/** Day-to-day spending accounts. */
export const SPENDING_ACCOUNTS: ReadonlySet<AccountType> = new Set(["checking", "credit_card"]);

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  cd: "CD",
  credit_card: "Credit card",
  mortgage: "Mortgage",
  heloc: "HELOC",
  auto_loan: "Auto loan",
  student_loan: "Student loan",
  personal_loan: "Personal loan",
  brokerage: "Brokerage",
  retirement_401k: "401(k) / 403(b)",
  ira: "Traditional IRA",
  roth_ira: "Roth IRA",
  hsa: "HSA",
  education_529: "529 plan",
  crypto: "Crypto",
  real_estate: "Real estate",
  vehicle: "Vehicle",
  other_asset: "Other asset",
  other_liability: "Other liability",
};

export function isLiability(a: Pick<Account, "type">): boolean {
  return LIABILITY_TYPES.has(a.type);
}

export function defaultTaxBucket(t: AccountType): TaxBucket {
  switch (t) {
    case "retirement_401k":
    case "ira":
      return "tax_deferred";
    case "roth_ira":
      return "tax_free";
    case "hsa":
      return "hsa";
    case "education_529":
      return "education";
    case "brokerage":
    case "crypto":
      return "taxable";
    default:
      return "none";
  }
}

export function defaultLiquidity(t: AccountType): LiquidityTier {
  if (LIABILITY_TYPES.has(t)) return "liability";
  switch (t) {
    case "checking":
      return "cash";
    case "savings":
    case "cd":
      return "near_cash";
    case "brokerage":
    case "crypto":
      return "invested";
    case "retirement_401k":
    case "ira":
    case "roth_ira":
    case "hsa":
    case "education_529":
      return "retirement";
    default:
      return "illiquid";
  }
}

export function liquidity(a: Account): LiquidityTier {
  return a.liquidity ?? defaultLiquidity(a.type);
}

export function taxBucket(a: Account): TaxBucket {
  return a.taxBucket ?? defaultTaxBucket(a.type);
}

/**
 * Normalize a reported balance to our sign convention (liabilities negative).
 * `owedIsPositive` is for sources (e.g. manual entry, some CSVs) that report
 * "amount owed" as a positive number. A credit balance on a card stays positive.
 */
export function normalizeBalance(type: AccountType, reported: number, owedIsPositive: boolean): number {
  return LIABILITY_TYPES.has(type) && owedIsPositive ? -reported : reported;
}

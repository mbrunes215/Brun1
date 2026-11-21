/**
 * Core domain types. Pure data: no DB or framework imports.
 *
 * Conventions
 * - Money is integer cents. Transaction amounts are signed from the account's
 *   point of view: negative = money leaving the account (purchase, payment out),
 *   positive = money arriving (paycheck, refund, payment received).
 * - Dates are ISO calendar dates "YYYY-MM-DD" in the household's time zone.
 * - Liability balances (credit cards, loans) are stored as negative numbers so
 *   net worth is a plain sum.
 */

export type Cents = number;
export type ISODate = string; // YYYY-MM-DD
export type MonthKey = string; // YYYY-MM

export type Owner = "A" | "B" | "joint";

export type AccountType =
  | "checking"
  | "savings"
  | "cd"
  | "credit_card"
  | "mortgage"
  | "heloc"
  | "auto_loan"
  | "student_loan"
  | "personal_loan"
  | "brokerage"
  | "retirement_401k"
  | "ira"
  | "roth_ira"
  | "hsa"
  | "education_529"
  | "crypto"
  | "real_estate"
  | "vehicle"
  | "other_asset"
  | "other_liability";

export type TaxBucket = "taxable" | "tax_deferred" | "tax_free" | "hsa" | "education" | "none";

export type LiquidityTier = "cash" | "near_cash" | "invested" | "retirement" | "illiquid" | "liability";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  owner: Owner;
  balance: Cents;
  /** Credit limit for cards (positive cents). */
  creditLimit?: Cents | null;
  apr?: number | null; // e.g. 0.2299
  minPayment?: Cents | null;
  promoAprEnd?: ISODate | null;
  statementCloseDay?: number | null;
  taxBucket?: TaxBucket;
  liquidity?: LiquidityTier;
  isHidden?: boolean;
  /** Excluded from budgets/cash flow (e.g. a business account). Still in net worth. */
  excludeFromCashFlow?: boolean;
}

export type BudgetType = "fixed" | "flex" | "non_monthly" | "income" | "savings" | "transfer";

export interface Category {
  id: string;
  name: string;
  group: string;
  budgetType: BudgetType;
  essential: boolean;
  /** Transactions in this category are excluded from spending (e.g. "Transfer", "Credit Card Payment"). */
  isTransferLike?: boolean;
  /** Fun-money category: line items hidden from the partner. */
  isPersonalAllowance?: boolean;
}

export interface TransactionLine {
  /** Present for split lines. */
  splitId?: string;
  amount: Cents;
  categoryId: string | null;
  owner?: Owner;
  tags?: string[];
}

export interface Transaction {
  id: string;
  accountId: string;
  date: ISODate;
  amount: Cents;
  payeeRaw: string;
  merchant?: string | null;
  categoryId: string | null;
  /** Defaults to the account owner when absent. */
  owner?: Owner;
  /** A household expense paid from a personal account (participates in settle-up). */
  isShared?: boolean;
  /** Hidden line items for personal allowance spending. */
  isPrivate?: boolean;
  isTransfer?: boolean;
  transferPairId?: string | null;
  isReimbursable?: boolean;
  /** For an inflow, the transaction it reimburses (removes both from budgets). */
  reimbursementOfId?: string | null;
  refundOfId?: string | null;
  pending?: boolean;
  isHidden?: boolean;
  /** A settle-up payment between partners. */
  isSettlement?: boolean;
  splits?: TransactionLine[];
  tags?: string[];
  externalId?: string | null;
  notes?: string | null;
}

/** How a single line contributes to the household's cash-flow picture. */
export type FlowKind =
  | "income"
  | "expense" // negative = spend, positive = refund netting the category
  | "savings" // money moved to savings/investment/debt-principal accounts (household view)
  | "transfer" // internal movement, ignored
  | "reimbursable" // fronted money expected back, ignored for budgets
  | "ignored";

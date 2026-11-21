import type { Cents, Owner } from "./types";

export type PayFrequency = "weekly" | "biweekly" | "semimonthly" | "monthly";

export const PERIODS_PER_YEAR: Record<PayFrequency, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };

export interface Deduction {
  label: string;
  kind: "retirement_pretax" | "hsa" | "fsa" | "health" | "roth_retirement" | "espp" | "other";
  amount: Cents; // per paycheck
}

export interface Paycheck {
  id: string;
  owner: Exclude<Owner, "joint">;
  employer: string;
  frequency: PayFrequency;
  gross: Cents;
  pretax: Deduction[];
  taxes: Cents;
  posttax: Deduction[];
  /** Employer 401k match / HSA contribution per paycheck (not in gross). */
  employerContrib: Cents;
  /** Expected net deposit; validated against gross - deductions - taxes. */
  net: Cents;
  depositAccountId?: string | null;
}

export function computedNet(p: Paycheck): Cents {
  const pre = p.pretax.reduce((s, d) => s + d.amount, 0);
  const post = p.posttax.reduce((s, d) => s + d.amount, 0);
  return p.gross - pre - p.taxes - post;
}

export function paycheckBalances(p: Paycheck): boolean {
  return Math.abs(computedNet(p) - p.net) <= 1;
}

export function monthly(perPaycheck: Cents, f: PayFrequency): Cents {
  return Math.round((perPaycheck * PERIODS_PER_YEAR[f]) / 12);
}

const SAVINGS_KINDS = new Set<Deduction["kind"]>(["retirement_pretax", "hsa", "roth_retirement", "espp"]);

export interface MonthlyIncomeModel {
  gross: Cents;
  net: Cents;
  taxes: Cents;
  /** Savings that never touch your bank account: payroll retirement/HSA/ESPP + employer contributions. */
  payrollSavings: Cents;
  employerContrib: Cents;
}

export function monthlyIncomeModel(paychecks: Paycheck[]): MonthlyIncomeModel {
  let gross = 0;
  let net = 0;
  let taxes = 0;
  let payroll = 0;
  let employer = 0;
  for (const p of paychecks) {
    gross += monthly(p.gross, p.frequency);
    net += monthly(p.net, p.frequency);
    taxes += monthly(p.taxes, p.frequency);
    employer += monthly(p.employerContrib, p.frequency);
    for (const d of [...p.pretax, ...p.posttax]) if (SAVINGS_KINDS.has(d.kind)) payroll += monthly(d.amount, p.frequency);
  }
  return { gross, net, taxes, payrollSavings: payroll + employer, employerContrib: employer };
}

/**
 * True savings rate =
 *   (payroll savings incl. employer match + savings from cash flow + extra debt principal)
 *   / (gross income + employer contributions)
 *
 * Including the match in both numerator and denominator is the common
 * convention among planners and FI writers. Most apps compute savings from
 * net deposits only, which understates savings by excluding pre-tax 401k/HSA.
 */
export function trueSavingsRate(params: {
  grossIncome: Cents;
  employerContrib: Cents;
  payrollSavings: Cents; // already includes employerContrib
  cashSavings: Cents; // net moved to savings/investments from bank accounts
  extraPrincipal?: Cents; // debt principal beyond minimums
}): number {
  const denom = params.grossIncome + params.employerContrib;
  if (denom <= 0) return 0;
  return (params.payrollSavings + params.cashSavings + (params.extraPrincipal ?? 0)) / denom;
}

/** Simple net savings rate from cash flow alone: (income - spending) / income. */
export function cashSavingsRate(income: Cents, spending: Cents): number {
  return income > 0 ? (income - spending) / income : 0;
}

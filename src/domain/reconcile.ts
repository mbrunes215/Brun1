import type { Cents, ISODate, Transaction } from "./types";

/**
 * Reconciliation: compare the bank-reported balance with the balance implied
 * by an anchor balance plus the transactions since. Drift means a missing,
 * duplicate, or mis-signed transaction.
 */
export interface ReconcileResult {
  reported: Cents;
  computed: Cents;
  drift: Cents; // reported - computed
  ok: boolean;
  suspects: Transaction[];
}

export function reconcile(params: {
  anchorBalance: Cents;
  anchorDate: ISODate; // balance as of end of this date
  reportedBalance: Cents;
  txns: Transaction[]; // for this account
  tolerance?: Cents;
}): ReconcileResult {
  const tol = params.tolerance ?? 100;
  const since = params.txns.filter((t) => t.date > params.anchorDate && !t.pending);
  const computed = params.anchorBalance + since.reduce((s, t) => s + t.amount, 0);
  const drift = params.reportedBalance - computed;
  const ok = Math.abs(drift) <= tol;
  // A single transaction equal to the drift (missing) or its negation (duplicate) is the likeliest culprit.
  const suspects = ok ? [] : since.filter((t) => t.amount === -drift || t.amount === drift);
  return { reported: params.reportedBalance, computed, drift, ok, suspects };
}

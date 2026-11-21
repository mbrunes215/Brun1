import { daysBetween } from "./money";
import type { Account, Transaction } from "./types";
import { LIABILITY_TYPES, SAVINGS_DESTINATIONS } from "./accounts";

const TRANSFER_HINT =
  /transfer|xfer|trnsfr|online pmt|online payment|payment[ -]thank you|thank you.*payment|autopay|auto pay|epay|e-payment|internet payment|mobile payment|crd pmt|card payment|payment received|to sav|from sav|to chk|from chk|to checking|from checking|to savings|from savings|withdrawal to|deposit from|ach (credit|debit)|brokerage|contribution/i;

export interface TransferMatch {
  outflowId: string;
  inflowId: string;
  confidence: "high" | "medium";
  dayGap: number;
}

export interface TransferOptions {
  windowDays?: number;
}

function plausiblePair(from: Account, to: Account): boolean {
  if (from.id === to.id) return false;
  // Paying a card or loan, or moving cash to savings/investments, or back.
  if (LIABILITY_TYPES.has(to.type)) return true;
  if (SAVINGS_DESTINATIONS.has(to.type) || SAVINGS_DESTINATIONS.has(from.type)) return true;
  if (from.type === "checking" && to.type === "checking") return true;
  return false;
}

/**
 * Find equal-and-opposite pairs across household accounts. Greedy global
 * matching by (hint strength, smallest day gap) so each transaction is used once.
 * High confidence pairs can be auto-linked; medium ones go to a review queue.
 */
export function detectTransfers(txns: Transaction[], accounts: Account[], opts: TransferOptions = {}): TransferMatch[] {
  const window = opts.windowDays ?? 4;
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const eligible = txns.filter((t) => !t.transferPairId && !t.isHidden && !t.pending && t.amount !== 0);
  const outflows = eligible.filter((t) => t.amount < 0);
  const inflowsByAmount = new Map<number, Transaction[]>();
  for (const t of eligible) {
    if (t.amount <= 0) continue;
    const arr = inflowsByAmount.get(t.amount);
    if (arr) arr.push(t);
    else inflowsByAmount.set(t.amount, [t]);
  }

  type Cand = TransferMatch & { score: number };
  const cands: Cand[] = [];
  for (const o of outflows) {
    const fromA = acct.get(o.accountId);
    if (!fromA) continue;
    for (const i of inflowsByAmount.get(-o.amount) ?? []) {
      const toA = acct.get(i.accountId);
      if (!toA || i.accountId === o.accountId) continue;
      const gap = Math.abs(daysBetween(o.date, i.date));
      if (gap > window) continue;
      if (!plausiblePair(fromA, toA)) continue;
      const hints = (TRANSFER_HINT.test(o.payeeRaw) ? 1 : 0) + (TRANSFER_HINT.test(i.payeeRaw) ? 1 : 0);
      const confidence = hints >= 1 ? "high" : "medium";
      cands.push({ outflowId: o.id, inflowId: i.id, confidence, dayGap: gap, score: hints * 10 - gap });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.dayGap - b.dayGap || a.outflowId.localeCompare(b.outflowId));
  const used = new Set<string>();
  const out: TransferMatch[] = [];
  for (const c of cands) {
    if (used.has(c.outflowId) || used.has(c.inflowId)) continue;
    used.add(c.outflowId);
    used.add(c.inflowId);
    out.push({ outflowId: c.outflowId, inflowId: c.inflowId, confidence: c.confidence, dayGap: c.dayGap });
  }
  return out;
}

export function isTransferHint(payee: string): boolean {
  return TRANSFER_HINT.test(payee);
}

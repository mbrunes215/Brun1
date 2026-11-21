import { daysBetween } from "./money";
import { payeeSimilarity } from "./merchant";
import type { Transaction } from "./types";

/**
 * Duplicate and pending-replacement detection for incoming transactions.
 *
 * - Exact: same account + same externalId -> update in place.
 * - Pending replaced: an existing pending txn on the same account whose amount is
 *   within 20% (tips, gas pre-auths) and date within 5 days, similar payee.
 * - Likely duplicate: same account, same amount, date within 2 days, similar
 *   payee, from a different source (e.g. CSV import overlapping bank sync).
 *   These are never silently dropped; they go to a review queue.
 */

export type IncomingVerdict =
  | { kind: "new" }
  | { kind: "update"; existingId: string }
  | { kind: "replaces_pending"; existingId: string }
  | { kind: "possible_duplicate"; existingId: string; score: number };

export function judgeIncoming(incoming: Transaction, existing: Transaction[]): IncomingVerdict {
  const sameAcct = existing.filter((e) => e.accountId === incoming.accountId);

  if (incoming.externalId) {
    const exact = sameAcct.find((e) => e.externalId === incoming.externalId);
    if (exact) return { kind: "update", existingId: exact.id };
  }

  if (!incoming.pending) {
    let best: { id: string; score: number } | null = null;
    for (const e of sameAcct) {
      if (!e.pending || e.externalId === incoming.externalId) continue;
      const gap = Math.abs(daysBetween(e.date, incoming.date));
      if (gap > 5) continue;
      if (Math.sign(e.amount) !== Math.sign(incoming.amount)) continue;
      const ratio = Math.abs(incoming.amount - e.amount) / Math.max(1, Math.abs(e.amount));
      if (ratio > 0.2) continue;
      const sim = payeeSimilarity(e.payeeRaw, incoming.payeeRaw);
      if (sim < 0.34) continue;
      const score = sim - ratio - gap * 0.05;
      if (!best || score > best.score) best = { id: e.id, score };
    }
    if (best) return { kind: "replaces_pending", existingId: best.id };
  }

  let dup: { id: string; score: number } | null = null;
  for (const e of sameAcct) {
    if (e.amount !== incoming.amount) continue;
    if (e.externalId && incoming.externalId && e.externalId !== incoming.externalId && e.pending === incoming.pending) {
      // Two distinct bank ids: the bank says these are different transactions,
      // but identical twins (two $5 coffees) are rare enough to still flag when same day + same payee.
      if (e.date !== incoming.date) continue;
    }
    const gap = Math.abs(daysBetween(e.date, incoming.date));
    if (gap > 2) continue;
    const sim = payeeSimilarity(e.payeeRaw, incoming.payeeRaw);
    if (sim < 0.5) continue;
    const score = sim - gap * 0.1;
    if (!dup || score > dup.score) dup = { id: e.id, score };
  }
  if (dup) return { kind: "possible_duplicate", existingId: dup.id, score: dup.score };
  return { kind: "new" };
}

/** Stable fingerprint for CSV rows that lack a bank id. */
export function fingerprint(t: Pick<Transaction, "accountId" | "date" | "amount" | "payeeRaw">, occurrence = 0): string {
  const p = t.payeeRaw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
  return `${t.accountId}|${t.date}|${t.amount}|${p}|${occurrence}`;
}

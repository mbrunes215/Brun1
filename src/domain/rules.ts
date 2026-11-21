import { cleanPayee, merchantKey } from "./merchant";
import type { Cents, Owner, Transaction } from "./types";

export interface RuleConditions {
  merchantEquals?: string;
  payeeContains?: string;
  payeeRegex?: string;
  amountMin?: Cents; // compares absolute amount
  amountMax?: Cents;
  amountExact?: Cents; // absolute
  direction?: "outflow" | "inflow";
  accountIds?: string[];
  owner?: Owner;
}

export interface RuleActions {
  setCategoryId?: string;
  setMerchant?: string;
  setOwner?: Owner;
  setShared?: boolean;
  addTags?: string[];
  markTransfer?: boolean;
  markReimbursable?: boolean;
  hide?: boolean;
  /** Split template as fractions of the total, e.g. [{categoryId, ratio: 0.7}, ...]. */
  splitTemplate?: Array<{ categoryId: string; ratio: number }>;
}

export interface Rule {
  id: string;
  name?: string;
  priority: number; // lower runs first; first matching rule wins per field
  enabled: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
}

export interface RuleTarget extends Transaction {
  accountOwner?: Owner;
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, "i");
  } catch {
    return null;
  }
}

export function ruleMatches(rule: Rule, t: RuleTarget): boolean {
  if (!rule.enabled) return false;
  const c = rule.conditions;
  const abs = Math.abs(t.amount);
  const merchant = t.merchant ?? cleanPayee(t.payeeRaw);
  if (c.merchantEquals && merchantKey(c.merchantEquals) !== merchantKey(merchant)) return false;
  if (c.payeeContains && !t.payeeRaw.toLowerCase().includes(c.payeeContains.toLowerCase())) return false;
  if (c.payeeRegex) {
    const re = safeRegex(c.payeeRegex);
    if (!re || !re.test(t.payeeRaw)) return false;
  }
  if (c.amountExact != null && abs !== c.amountExact) return false;
  if (c.amountMin != null && abs < c.amountMin) return false;
  if (c.amountMax != null && abs > c.amountMax) return false;
  if (c.direction === "outflow" && t.amount >= 0) return false;
  if (c.direction === "inflow" && t.amount <= 0) return false;
  if (c.accountIds?.length && !c.accountIds.includes(t.accountId)) return false;
  if (c.owner && (t.owner ?? t.accountOwner) !== c.owner) return false;
  // A rule with no conditions never matches (guards against accidental catch-alls).
  return Object.values(c).some((v) => v != null && !(Array.isArray(v) && v.length === 0));
}

export type TxnPatch = Partial<
  Pick<Transaction, "categoryId" | "merchant" | "owner" | "isShared" | "tags" | "isTransfer" | "isReimbursable" | "isHidden" | "splits">
> & { matchedRuleIds: string[] };

/** Apply rules in priority order. For each field, the first rule that sets it wins. */
export function applyRules(t: RuleTarget, rules: Rule[]): TxnPatch {
  const patch: TxnPatch = { matchedRuleIds: [] };
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const tags = new Set(t.tags ?? []);
  for (const r of sorted) {
    if (!ruleMatches(r, t)) continue;
    patch.matchedRuleIds.push(r.id);
    const a = r.actions;
    if (a.setCategoryId && patch.categoryId === undefined) patch.categoryId = a.setCategoryId;
    if (a.setMerchant && patch.merchant === undefined) patch.merchant = a.setMerchant;
    if (a.setOwner && patch.owner === undefined) patch.owner = a.setOwner;
    if (a.setShared != null && patch.isShared === undefined) patch.isShared = a.setShared;
    if (a.markTransfer && patch.isTransfer === undefined) patch.isTransfer = true;
    if (a.markReimbursable && patch.isReimbursable === undefined) patch.isReimbursable = true;
    if (a.hide && patch.isHidden === undefined) patch.isHidden = true;
    if (a.addTags) for (const tg of a.addTags) tags.add(tg);
    if (a.splitTemplate?.length && patch.splits === undefined) patch.splits = buildSplits(t.amount, a.splitTemplate);
  }
  if (tags.size !== (t.tags?.length ?? 0)) patch.tags = [...tags];
  return patch;
}

function buildSplits(amount: Cents, template: Array<{ categoryId: string; ratio: number }>) {
  const total = template.reduce((s, x) => s + x.ratio, 0);
  let assigned = 0;
  return template.map((x, i) => {
    const amt = i === template.length - 1 ? amount - assigned : Math.round((amount * x.ratio) / total);
    assigned += amt;
    return { splitId: `s${i}`, amount: amt, categoryId: x.categoryId };
  });
}

/**
 * Categorization fallback chain: rules -> merchant memory -> provider category.
 * Merchant memory = the category most recently assigned by a human to the same merchant.
 */
export function suggestCategory(
  t: RuleTarget,
  rules: Rule[],
  merchantMemory: Map<string, string>,
  providerCategoryId?: string | null,
): { categoryId: string | null; source: "rule" | "memory" | "provider" | "none"; patch: TxnPatch } {
  const patch = applyRules(t, rules);
  if (patch.categoryId) return { categoryId: patch.categoryId, source: "rule", patch };
  const m = merchantMemory.get(merchantKey(patch.merchant ?? t.merchant ?? cleanPayee(t.payeeRaw)));
  if (m) return { categoryId: m, source: "memory", patch };
  if (providerCategoryId) return { categoryId: providerCategoryId, source: "provider", patch };
  return { categoryId: null, source: "none", patch };
}

/** Preview which existing transactions a rule would change (for "apply to past" confirmation). */
export function previewRule(rule: Rule, txns: RuleTarget[]): Array<{ id: string; from: string | null; to: string | null }> {
  const out: Array<{ id: string; from: string | null; to: string | null }> = [];
  for (const t of txns) {
    if (!ruleMatches({ ...rule, enabled: true }, t)) continue;
    const to = rule.actions.setCategoryId ?? t.categoryId;
    if (to !== t.categoryId) out.push({ id: t.id, from: t.categoryId, to });
  }
  return out;
}

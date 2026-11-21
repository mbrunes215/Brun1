import type { ClassifiedLine } from "./ledger";
import type { Cents } from "./types";

export const TAX_TAGS = [
  { key: "tax_deductible", label: "Tax deductible" },
  { key: "charitable", label: "Charitable gift" },
  { key: "hsa_eligible", label: "HSA-eligible medical" },
  { key: "fsa_eligible", label: "FSA-eligible" },
  { key: "dependent_care", label: "Dependent care" },
  { key: "business", label: "Business expense" },
  { key: "education_529", label: "529-eligible education" },
  { key: "reimbursable", label: "Reimbursable" },
] as const;

export type TaxTag = (typeof TAX_TAGS)[number]["key"];

export interface TaxPacket {
  year: number;
  totalsByTag: Record<string, Cents>;
  linesByTag: Record<string, ClassifiedLine[]>;
}

/** Annual totals per tax tag. Spend is reported positive. */
export function taxPacket(lines: ClassifiedLine[], year: number): TaxPacket {
  const totals: Record<string, Cents> = {};
  const byTag: Record<string, ClassifiedLine[]> = {};
  for (const l of lines) {
    if (!l.date.startsWith(String(year))) continue;
    for (const tag of l.tags) {
      totals[tag] = (totals[tag] ?? 0) - l.amount;
      (byTag[tag] ??= []).push(l);
    }
  }
  return { year, totalsByTag: totals, linesByTag: byTag };
}

/**
 * Contribution limits are stored per year in the database and editable in
 * Settings. Values are seeded from IRS announcements; verify each year.
 */
export interface ContributionLimit {
  year: number;
  key: "401k_employee" | "401k_catchup_50" | "ira" | "ira_catchup_50" | "hsa_self" | "hsa_family" | "hsa_catchup_55";
  amount: Cents;
  source: string;
}

export function contributionProgress(contributed: Cents, limit: Cents, monthsElapsed: number) {
  const remaining = Math.max(0, limit - contributed);
  const monthsLeft = Math.max(0, 12 - monthsElapsed);
  return {
    contributed,
    limit,
    remaining,
    pct: limit > 0 ? Math.min(1, contributed / limit) : 0,
    perMonthToMax: monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining,
  };
}

import { getDb, schema, type DB } from "@/db";
import { defaultCategories } from "@/domain/categories";

/**
 * IRS contribution limits (cents). 2026 values verified against IRS IR-2025-111
 * and Rev. Proc. 2025-19. 2027 values are from IRS IR-2026-136 and
 * Rev. Proc. 2026-24 summaries; confirm in Settings before relying on them.
 */
export const CONTRIBUTION_LIMITS = [
  { year: 2026, key: "401k_employee", amount: 2450000, source: "IRS IR-2025-111" },
  { year: 2026, key: "401k_catchup_50", amount: 800000, source: "IRS IR-2025-111" },
  { year: 2026, key: "401k_catchup_60_63", amount: 1125000, source: "IRS IR-2025-111 (SECURE 2.0)" },
  { year: 2026, key: "ira", amount: 750000, source: "IRS IR-2025-111" },
  { year: 2026, key: "ira_catchup_50", amount: 110000, source: "IRS IR-2025-111" },
  { year: 2026, key: "hsa_self", amount: 440000, source: "Rev. Proc. 2025-19" },
  { year: 2026, key: "hsa_family", amount: 875000, source: "Rev. Proc. 2025-19" },
  { year: 2026, key: "hsa_catchup_55", amount: 100000, source: "Statutory" },
  { year: 2027, key: "401k_employee", amount: 2550000, source: "IRS IR-2026-136 (verify)" },
  { year: 2027, key: "ira", amount: 750000, source: "IRS IR-2026-136 (verify)" },
  { year: 2027, key: "ira_catchup_50", amount: 110000, source: "IRS IR-2026-136 (verify)" },
  { year: 2027, key: "hsa_self", amount: 450000, source: "Rev. Proc. 2026-24 (verify)" },
  { year: 2027, key: "hsa_family", amount: 900000, source: "Rev. Proc. 2026-24 (verify)" },
  { year: 2027, key: "hsa_catchup_55", amount: 100000, source: "Statutory" },
];

/**
 * Starter rules (low priority, editable). They run after any rule the household
 * writes, so personal rules always win.
 */
const STARTER_RULES: Array<[string, string, string]> = [
  ["Payroll", "payroll|direct dep|dir dep|salary|adp|gusto|paychex", "income_paychecks"],
  ["Interest earned", "interest (paid|earned|payment)|^interest$|int earned|dividend", "income_interest_and_dividends"],
  ["Tax refund", "irs treas|tax ref|state of .* tax", "income_tax_refund"],
  ["Groceries", "whole ?f(oo)?ds|trader joe|safeway|kroger|aldi|publix|wegmans|h-e-b|heb |sprouts|food lion|giant|stop & shop|albertsons|instacart", "food_groceries"],
  ["Coffee", "starbucks|dunkin|peet|blue bottle|dutch bros", "food_coffee_shops"],
  ["Food delivery", "doordash|uber ?eats|grubhub|postmates|seamless", "food_restaurants_and_takeout"],
  ["Gas", "shell|chevron|exxon|mobil|bp#|\\bbp\\b|sunoco|wawa|speedway|valero|marathon|76 |arco|circle k|tesla supercharger|chargepoint|electrify america", "transportation_gas_and_charging"],
  ["Rideshare", "\\buber\\b(?! ?eats)|lyft|transit|mta |bart|clipper", "transportation_rideshare_and_transit"],
  ["Streaming", "netflix|spotify|hulu|disney ?plus|disney\\+|hbo|max\\.com|youtube ?premium|apple ?tv|paramount|peacock|audible", "lifestyle_streaming_and_subscriptions"],
  ["Pharmacy", "cvs|walgreens|rite aid|pharmacy", "health_pharmacy"],
  ["Phone", "verizon|t-mobile|at&t|mint mobile|visible|google fi", "utilities_phone"],
  ["Internet", "comcast|xfinity|spectrum|fios|cox comm|att internet|starlink", "utilities_internet"],
  ["Gym", "planet fitness|equinox|peloton|orangetheory|ymca|crunch fitness|la fitness|anytime fitness", "health_fitness"],
  ["Bank fees", "overdraft|monthly service fee|maintenance fee|atm fee|foreign transaction fee", "fees_and_taxes_bank_fees"],
  ["Card interest", "interest charge|purchase interest|finance charge", "debt_payments_credit_card_interest"],
];

export function seedHousehold(householdId: string, names: { A: string; B: string }, db: DB = getDb()) {
  const cats = defaultCategories(names);
  db.transaction((tx) => {
    cats.forEach((c, i) =>
      tx.insert(schema.categories)
        .values({
          id: `${householdId.slice(0, 8)}_${c.id}`,
          householdId,
          name: c.name,
          group: c.group,
          budgetType: c.budgetType,
          essential: c.essential,
          isTransferLike: !!c.isTransferLike,
          isPersonalAllowance: !!c.isPersonalAllowance,
          sortOrder: i,
        })
        .run(),
    );
    for (const l of CONTRIBUTION_LIMITS) tx.insert(schema.contributionLimits).values(l).onConflictDoNothing().run();
    STARTER_RULES.forEach(([name, regex, slug], i) =>
      tx.insert(schema.rules)
        .values({
          id: `${householdId.slice(0, 8)}_starter_${i}`,
          householdId,
          name: `Starter: ${name}`,
          priority: 1000 + i,
          enabled: true,
          conditions: { payeeRegex: regex },
          actions: { setCategoryId: catId(householdId, slug) },
        })
        .run(),
    );
  });
}

/** Category ids are namespaced per household; this maps a default slug to the real id. */
export function catId(householdId: string, slug: string): string {
  return `${householdId.slice(0, 8)}_${slug}`;
}

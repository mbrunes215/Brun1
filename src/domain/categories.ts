import type { BudgetType, Category } from "./types";

/**
 * Default category tree, organized the way a planner reads a spending plan.
 * Groceries vs dining are always separate (the most common leak). Each category
 * is flagged essential vs discretionary for emergency-fund and downturn math.
 */
type Def = [name: string, budgetType: BudgetType, essential: boolean, extra?: Partial<Category>];

const TREE: Record<string, Def[]> = {
  Income: [
    ["Paychecks", "income", false],
    ["Bonus", "income", false],
    ["Side & business income", "income", false],
    ["Interest & dividends", "income", false],
    ["Tax refund", "income", false],
    ["Gifts received", "income", false],
    ["Other income", "income", false],
  ],
  Housing: [
    ["Rent", "fixed", true],
    ["Mortgage", "fixed", true],
    ["HOA dues", "fixed", true],
    ["Property tax", "non_monthly", true],
    ["Home insurance", "non_monthly", true],
    ["Home maintenance & repairs", "non_monthly", false],
    ["Furnishings", "flex", false],
  ],
  Utilities: [
    ["Electric & gas", "fixed", true],
    ["Water, sewer & trash", "fixed", true],
    ["Internet", "fixed", true],
    ["Phone", "fixed", true],
  ],
  Food: [
    ["Groceries", "flex", true],
    ["Restaurants & takeout", "flex", false],
    ["Coffee shops", "flex", false],
    ["Alcohol & bars", "flex", false],
  ],
  Transportation: [
    ["Gas & charging", "flex", true],
    ["Car payment", "fixed", true],
    ["Auto insurance", "non_monthly", true],
    ["Car maintenance", "non_monthly", true],
    ["Registration & fees", "non_monthly", true],
    ["Parking & tolls", "flex", false],
    ["Rideshare & transit", "flex", false],
  ],
  Insurance: [
    ["Health insurance", "fixed", true],
    ["Life insurance", "fixed", true],
    ["Disability insurance", "fixed", true],
    ["Umbrella insurance", "non_monthly", false],
  ],
  Health: [
    ["Medical & dental", "flex", true],
    ["Pharmacy", "flex", true],
    ["Vision", "non_monthly", true],
    ["Fitness", "fixed", false],
    ["Therapy & wellness", "flex", false],
  ],
  "Debt payments": [
    ["Credit card interest", "fixed", true],
    ["Student loan payment", "fixed", true],
    ["Personal loan payment", "fixed", true],
  ],
  "Kids & pets": [
    ["Childcare", "fixed", true],
    ["Kids activities", "flex", false],
    ["Pet care", "flex", false],
  ],
  Personal: [
    ["Clothing", "non_monthly", false],
    ["Hair & beauty", "flex", false],
    ["Fun money - Partner A", "flex", false, { isPersonalAllowance: true }],
    ["Fun money - Partner B", "flex", false, { isPersonalAllowance: true }],
  ],
  Shopping: [
    ["General merchandise", "flex", false],
    ["Electronics", "flex", false],
    ["Household supplies", "flex", true],
  ],
  Lifestyle: [
    ["Entertainment", "flex", false],
    ["Streaming & subscriptions", "fixed", false],
    ["Hobbies", "flex", false],
    ["Annual memberships", "non_monthly", false],
  ],
  Travel: [
    ["Vacation", "non_monthly", false],
    ["Flights", "non_monthly", false],
    ["Lodging", "non_monthly", false],
  ],
  Giving: [
    ["Charity", "flex", false],
    ["Gifts", "non_monthly", false],
    ["Holidays", "non_monthly", false],
  ],
  Education: [
    ["Tuition", "non_monthly", false],
    ["Books & courses", "flex", false],
  ],
  Business: [["Business expenses", "flex", false]],
  "Fees & taxes": [
    ["Bank fees", "flex", false],
    ["Taxes paid", "non_monthly", true],
    ["Tax prep", "non_monthly", false],
  ],
  "Savings & investing": [
    ["Savings contribution", "savings", false],
    ["Investment contribution", "savings", false],
    ["Retirement contribution", "savings", false],
  ],
  Transfers: [
    ["Transfer", "transfer", false, { isTransferLike: true }],
    ["Credit card payment", "transfer", false, { isTransferLike: true }],
    ["Partner settle-up", "transfer", false, { isTransferLike: true }],
  ],
};

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function defaultCategories(names: { A: string; B: string } = { A: "Partner A", B: "Partner B" }): Category[] {
  const out: Category[] = [];
  for (const [group, defs] of Object.entries(TREE)) {
    for (const [rawName, budgetType, essential, extra] of defs) {
      const name = rawName.replace("Partner A", names.A).replace("Partner B", names.B);
      out.push({ id: slug(`${group}_${rawName}`), name, group, budgetType, essential, ...extra });
    }
  }
  return out;
}

export const CATEGORY_GROUP_ORDER = Object.keys(TREE);

/** Keywords used to map bank/provider category strings to our defaults on import. */
export const PROVIDER_CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/grocer|supermarket/i, "food_groceries"],
  [/restaurant|dining|fast food|food and drink/i, "food_restaurants_and_takeout"],
  [/coffee/i, "food_coffee_shops"],
  [/gas station|fuel|gasoline/i, "transportation_gas_and_charging"],
  [/rideshare|taxi|transit|uber|lyft/i, "transportation_rideshare_and_transit"],
  [/pharmacy|drugstore/i, "health_pharmacy"],
  [/utilities|electric/i, "utilities_electric_and_gas"],
  [/internet|cable/i, "utilities_internet"],
  [/phone|mobile|wireless/i, "utilities_phone"],
  [/streaming|subscription/i, "lifestyle_streaming_and_subscriptions"],
  [/travel|airline|hotel/i, "travel_vacation"],
  [/payroll|paycheck|salary|direct dep/i, "income_paychecks"],
  [/interest income|dividend/i, "income_interest_and_dividends"],
  [/transfer/i, "transfers_transfer"],
  [/credit card payment/i, "transfers_credit_card_payment"],
];

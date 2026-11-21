/**
 * Creates a realistic demo household with 12 months of history so every screen
 * has something to show. Uses the real ingest pipeline (rules, transfer
 * detection, dedupe), so it doubles as an end-to-end exercise of the engine.
 *
 *   DATA_DIR=./data-demo npx tsx scripts/seed-demo.ts
 *   login: alex@demo.local / demo-password-123 (partner: sam@demo.local)
 */
import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { openDb, schema } from "../src/db";
import { seedHousehold, catId } from "../src/server/seed";
import { ingest, type IncomingTxn } from "../src/server/ingest";
import { addDays, addMonths, addMonthsToDate, monthEnd } from "../src/domain/money";
import { defaultLiquidity, defaultTaxBucket } from "../src/domain/accounts";
import type { AccountType } from "../src/domain/types";

const { db } = openDb();
if (db.select().from(schema.users).all().length) {
  console.log("Database already has users; skipping demo seed.");
  process.exit(0);
}

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const between = (a: number, b: number) => Math.round((a + rand() * (b - a)) * 100);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;

const today = new Date().toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);
const start = `${addMonths(thisMonth, -12)}-01`;
const HH = "demo0000-0000-4000-8000-000000000000";

async function main() {
  db.insert(schema.households)
    .values({
      id: HH,
      name: "Alex & Sam",
      timezone: "America/New_York",
      settings: { partnerNames: { A: "Alex", B: "Sam" }, lowBalanceFloor: 75000, largeTxnThreshold: 60000, retirement: { ageA: 34, ageB: 32, retireAge: 62, realReturn: 0.05 } },
      splitPolicy: { default: { mode: "income" }, byCategory: { [catId(HH, "food_groceries")]: { mode: "equal" } }, incomeA: 0, incomeB: 0 },
    })
    .run();
  const pw = await hash("demo-password-123", { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  db.insert(schema.users).values({ id: "demo-user-a", householdId: HH, email: "alex@demo.local", name: "Alex", slot: "A", passwordHash: pw, isAdmin: true }).run();
  db.insert(schema.users).values({ id: "demo-user-b", householdId: HH, email: "sam@demo.local", name: "Sam", slot: "B", passwordHash: pw }).run();
  seedHousehold(HH, { A: "Alex", B: "Sam" }, db);

  // Household rule: grocery runs on personal cards are shared costs.
  db.insert(schema.rules).values({ id: "demo-rule-groceries", householdId: HH, name: "Groceries are shared", priority: 10, enabled: true, conditions: { payeeRegex: "whole ?f|trader joe|safeway" }, actions: { setCategoryId: catId(HH, "food_groceries"), setShared: true } }).run();
  db.insert(schema.rules).values({ id: "demo-rule-venmo", householdId: HH, name: "Venmo to partner", priority: 5, enabled: true, conditions: { payeeContains: "VENMO SAM" }, actions: { setCategoryId: catId(HH, "transfers_partner_settle_up") } }).run();

  type Acct = { id: string; name: string; type: AccountType; owner: "A" | "B" | "joint"; balance: number; extra?: Partial<typeof schema.accounts.$inferInsert> };
  const accounts: Acct[] = [
    { id: "chkA", name: "Alex Checking", type: "checking", owner: "A", balance: 412000 },
    { id: "chkB", name: "Sam Checking", type: "checking", owner: "B", balance: 268000 },
    { id: "joint", name: "Joint Checking", type: "checking", owner: "joint", balance: 355000 },
    { id: "ccA", name: "Alex Sapphire Visa", type: "credit_card", owner: "A", balance: -184000, extra: { creditLimit: 1500000, apr: 0.2299, statementCloseDay: 22 } },
    { id: "ccB", name: "Sam Amex Blue", type: "credit_card", owner: "B", balance: -96000, extra: { creditLimit: 800000, apr: 0.2124 } },
    { id: "hysa", name: "Joint High-Yield Savings", type: "savings", owner: "joint", balance: 1840000 },
    { id: "k401", name: "Alex 401(k)", type: "retirement_401k", owner: "A", balance: 8650000 },
    { id: "roth", name: "Sam Roth IRA", type: "roth_ira", owner: "B", balance: 3120000 },
    { id: "brok", name: "Alex Brokerage", type: "brokerage", owner: "A", balance: 2275000 },
    { id: "home", name: "Home", type: "real_estate", owner: "joint", balance: 46500000, extra: { isManual: true, valueChangeRate: 0.03 } },
    { id: "mort", name: "Mortgage", type: "mortgage", owner: "joint", balance: -33480000, extra: { apr: 0.0625, minPayment: 215000, linkedAssetId: "home" } },
    { id: "car", name: "Sam's Subaru", type: "vehicle", owner: "B", balance: 2150000, extra: { isManual: true, valueChangeRate: -0.15 } },
    { id: "autoloan", name: "Auto loan", type: "auto_loan", owner: "B", balance: -1390000, extra: { apr: 0.059, minPayment: 42000 } },
    { id: "student", name: "Alex Student Loan", type: "student_loan", owner: "A", balance: -1780000, extra: { apr: 0.045, minPayment: 21000 } },
  ];
  for (const a of accounts) {
    db.insert(schema.accounts)
      .values({ id: a.id, householdId: HH, name: a.name, type: a.type, owner: a.owner, balance: a.balance, balanceDate: today, taxBucket: defaultTaxBucket(a.type), liquidity: defaultLiquidity(a.type), ...a.extra })
      .run();
  }

  const tx: Record<string, IncomingTxn[]> = Object.fromEntries(accounts.map((a) => [a.id, []]));
  const add = (acct: string, date: string, amount: number, payee: string) => {
    if (date > today) return;
    tx[acct]!.push({ date, amount, payee });
  };
  const transfer = (from: string, to: string, date: string, amount: number, outPayee: string, inPayee: string) => {
    add(from, date, -amount, outPayee);
    add(to, addDays(date, 1) > today ? date : addDays(date, 1), amount, inPayee);
  };

  // Paychecks: Alex biweekly, Sam semimonthly.
  for (let d = addDays(start, 4); d <= today; d = addDays(d, 14)) add("chkA", d, 315842, "ACME ROBOTICS PAYROLL DIR DEP");
  for (let m = 0; m <= 12; m++) {
    const mo = addMonths(start.slice(0, 7), m);
    const jointEra = m >= 8; // couple opened a joint account ~4 months ago
    for (const day of ["15", String(new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).getUTCDate())]) {
      add(jointEra ? "joint" : "chkB", `${mo}-${day.padStart(2, "0")}`, 248930, "CITY SCHOOLS PAYROLL");
    }
    const first = `${mo}-01`;
    // Mortgage, car, student loan (linked transfers to tracked loans).
    transfer(jointEra ? "joint" : "chkA", "mort", `${mo}-01`, 215000, "WELLS FARGO HOME MTG AUTO PAY", "PAYMENT RECEIVED");
    transfer("chkB", "autoloan", `${mo}-07`, 42000, "SUBARU MOTORS FIN AUTOPAY", "PAYMENT RECEIVED");
    transfer("chkA", "student", `${mo}-12`, 21000, "NELNET STUDENT LOAN PMT", "PAYMENT RECEIVED");
    if (jointEra) {
      transfer("chkA", "joint", `${mo}-02`, 150000, "TRANSFER TO JOINT CHECKING", "TRANSFER FROM ALEX CHECKING");
    }
    // Savings and investing.
    transfer("chkA", "hysa", `${mo}-05`, 50000, "TRANSFER TO SAVINGS", "TRANSFER FROM CHECKING");
    transfer("chkA", "brok", `${mo}-06`, 40000, "TRANSFER TO BROKERAGE", "ACH CONTRIBUTION");
    add("k401", `${mo}-15`, 105000, "EMPLOYEE CONTRIBUTION");
    add("k401", `${mo}-15`, 42000, "EMPLOYER MATCH CONTRIBUTION");
    if (m % 3 === 0) add("roth", `${mo}-10`, 187500, "CONTRIBUTION");
    // Bills.
    add("ccA", `${mo}-03`, -7999, "XFINITY INTERNET");
    add("ccA", `${mo}-18`, -between(85, 175), "CON EDISON ELECTRIC");
    add("ccB", `${mo}-20`, -12000, "VERIZON WIRELESS");
    add("ccA", `${mo}-09`, m >= 10 ? -1799 : -1549, "NETFLIX.COM");
    add("ccB", `${mo}-14`, -1199, "SPOTIFY USA");
    add("chkA", `${mo}-02`, -4500, "PLANET FITNESS");
    add("joint", `${mo}-21`, -6500, "WATER & SEWER AUTH");
    // Groceries (shared via rule), dining, coffee, gas, shopping.
    for (let w = 0; w < 4; w++) {
      add(w % 2 ? "ccB" : "ccA", addDays(first, 3 + w * 7), -between(95, 210), pick(["WHOLEFDS MKT 10234", "TRADER JOE'S #552", "SAFEWAY 1123"]));
      add(pick(["ccA", "ccB"]), addDays(first, 5 + w * 7), -between(18, 95), pick(["SQ *TACOS EL GORDO", "TST* PIZZERIA LOLA", "CHIPOTLE 0423", "SWEETGREEN NYC", "UBER EATS PENDING"]));
      add("ccA", addDays(first, 2 + w * 7), -between(4, 7), "STARBUCKS STORE 1123");
      add(w % 2 ? "ccB" : "ccA", addDays(first, 6 + w * 7), -between(38, 62), pick(["SHELL OIL 5739", "CHEVRON 0091"]));
    }
    add("ccA", addDays(first, 11), -between(20, 160), "AMZN Mktp US*2K4L19XY2");
    add("ccB", addDays(first, 16), -between(30, 120), "TARGET 00012345");
    if (m % 4 === 1) add("ccB", addDays(first, 19), between(15, 40), "TARGET 00012345"); // return
    // Personal fun money.
    add("ccA", addDays(first, 13), -between(25, 80), "STEAM GAMES");
    add("ccB", addDays(first, 23), -between(30, 90), "SEPHORA");
    // Card payments in full from personal checking.
    // (Approximation: pay last month's card spend; detection links them as transfers.)
    // Irregular expenses.
    if (m === 2 || m === 8) add("ccB", `${mo}-10`, -78000, "GEICO AUTO INSURANCE");
    if (m === 6) {
      add("ccA", `${mo}-04`, -91200, "DELTA AIR LINES");
      add("ccA", `${mo}-20`, -118500, "MARRIOTT HOTELS");
    }
    if (m === 11) add("ccA", `${mo}-08`, -13900, "AMAZON PRIME*MEMBERSHIP");
    if (m === 9) add("ccB", `${mo}-03`, -42500, "JIFFY LUBE / TIRE SHOP");
    // Settle-up: Sam pays Alex back via Venmo every other month.
    if (m % 2 === 1 && m < 8) transfer("chkB", "chkA", `${mo}-25`, 30000, "VENMO SAM TO ALEX", "VENMO CASHOUT FROM SAM");
    // Interest earned.
    add("hysa", monthEnd(mo), between(55, 70), "INTEREST PAID");
  }
  // Card payments: pay each month's card spend on the 25th of the following month.
  for (const [card, payer] of [["ccA", "chkA"], ["ccB", "chkB"]] as const) {
    for (let m = 1; m <= 12; m++) {
      const mo = addMonths(start.slice(0, 7), m);
      const prev = addMonths(mo, -1);
      const spend = tx[card]!.filter((t) => t.date.startsWith(prev)).reduce((s, t) => s + t.amount, 0);
      if (spend < 0) transfer(payer, card, `${mo}-25`, -spend, `${card === "ccA" ? "CHASE CARD" : "AMEX EPAYMENT"} ONLINE PMT`, "PAYMENT THANK YOU");
    }
  }
  let inserted = 0;
  for (const [acct, list] of Object.entries(tx)) {
    if (!list.length) continue;
    const r = ingest(HH, acct, "csv", list.sort((a, b) => a.date.localeCompare(b.date)), db, "demo-user-a");
    inserted += r.inserted;
  }

  // Mark the Venmo legs as settlements, and older history as reviewed.
  for (const t of db.select().from(schema.transactions).where(eq(schema.transactions.householdId, HH)).all()) {
    const patch: Partial<typeof schema.transactions.$inferInsert> = {};
    if (/VENMO/.test(t.payeeRaw)) patch.isSettlement = true;
    if (t.date < addDays(today, -10)) {
      patch.reviewedAt = new Date().toISOString();
      patch.reviewedBy = t.accountId.endsWith("B") ? "demo-user-b" : "demo-user-a";
    }
    if (t.payeeRaw === "STEAM GAMES") patch.categoryId = catId(HH, "personal_fun_money_partner_a");
    if (t.payeeRaw === "SEPHORA") patch.categoryId = catId(HH, "personal_fun_money_partner_b");
    if (t.payeeRaw.startsWith("DELTA")) patch.categoryId = catId(HH, "travel_flights");
    if (t.payeeRaw.startsWith("MARRIOTT")) patch.categoryId = catId(HH, "travel_lodging");
    if (t.payeeRaw.startsWith("GEICO")) patch.categoryId = catId(HH, "transportation_auto_insurance");
    if (t.payeeRaw.startsWith("AMAZON PRIME")) patch.categoryId = catId(HH, "lifestyle_annual_memberships");
    if (t.payeeRaw.startsWith("JIFFY")) patch.categoryId = catId(HH, "transportation_car_maintenance");
    if (t.payeeRaw.startsWith("WELLS FARGO")) patch.categoryId = catId(HH, "housing_mortgage");
    if (t.payeeRaw.startsWith("SUBARU")) patch.categoryId = catId(HH, "transportation_car_payment");
    if (t.payeeRaw.startsWith("NELNET")) patch.categoryId = catId(HH, "debt_payments_student_loan_payment");
    if (/AMZN|TARGET/.test(t.payeeRaw) && !t.categoryId) patch.categoryId = catId(HH, "shopping_general_merchandise");
    if (/CON EDISON/.test(t.payeeRaw)) patch.categoryId = catId(HH, "utilities_electric_and_gas");
    if (/WATER/.test(t.payeeRaw)) patch.categoryId = catId(HH, "utilities_water_sewer_and_trash");
    if (/TACOS|PIZZERIA|CHIPOTLE|SWEETGREEN/.test(t.payeeRaw)) patch.categoryId = catId(HH, "food_restaurants_and_takeout");
    if (/CONTRIBUTION|MATCH/.test(t.payeeRaw) && ["k401", "roth"].includes(t.accountId)) patch.categoryId = catId(HH, "savings_and_investing_retirement_contribution");
    if (Object.keys(patch).length) {
      if (patch.categoryId) patch.categorySource = "user";
      db.update(schema.transactions).set(patch).where(eq(schema.transactions.id, t.id)).run();
    }
    if (/VENMO SAM TO ALEX/.test(t.payeeRaw)) db.insert(schema.settlements).values({ id: `set-${t.id}`, householdId: HH, date: t.date, from: "B", to: "A", amount: -t.amount, txnId: t.id }).run();
  }

  // Monthly balance snapshots with plausible trends (current balance at the end).
  const growth: Record<string, number> = { k401: 0.009, roth: 0.008, brok: 0.007, hysa: 0.012, home: 0.0025, car: -0.0125, mort: -0.0022, autoloan: -0.028, student: -0.009 };
  for (const a of accounts) {
    for (let i = 12; i >= 0; i--) {
      const m = addMonths(thisMonth, -i);
      const date = i === 0 ? today : monthEnd(m);
      const g = growth[a.id] ?? 0;
      const wobble = a.type === "checking" || a.type === "credit_card" ? 1 + (rand() - 0.5) * 0.25 : 1;
      const bal = Math.round((a.balance / Math.pow(1 + g, i)) * (i === 0 ? 1 : wobble));
      db.insert(schema.balanceSnapshots).values({ accountId: a.id, date, balance: bal }).onConflictDoNothing().run();
    }
  }

  // Paychecks.
  db.insert(schema.paychecks)
    .values({
      id: "pc-a",
      householdId: HH,
      owner: "A",
      employer: "Acme Robotics",
      frequency: "biweekly",
      gross: 520000,
      pretax: [
        { label: "401(k) 10%", kind: "retirement_pretax", amount: 52000 },
        { label: "Medical/dental", kind: "health", amount: 14200 },
        { label: "HSA", kind: "hsa", amount: 8000 },
      ],
      taxes: 129958,
      posttax: [],
      employerContrib: 20800,
      net: 315842,
      depositAccountId: "chkA",
    })
    .run();
  db.insert(schema.paychecks)
    .values({
      id: "pc-b",
      householdId: HH,
      owner: "B",
      employer: "City Schools",
      frequency: "semimonthly",
      gross: 337500,
      pretax: [{ label: "403(b)", kind: "retirement_pretax", amount: 20250 }],
      taxes: 61820,
      posttax: [{ label: "Union dues", kind: "other", amount: 6500 }],
      employerContrib: 0,
      net: 248930,
      depositAccountId: "joint",
    })
    .run();

  // Budget plan for this month and last month.
  for (const mo of [addMonths(thisMonth, -1), thisMonth]) {
    const id = `bm-${mo}`;
    db.insert(schema.budgetMonths).values({ id, householdId: HH, month: mo, expectedIncome: 1180000, savingsGoals: 90000, flexTotal: 320000 }).run();
    const lines: Array<[string, number]> = [
      ["housing_mortgage", 215000],
      ["transportation_car_payment", 42000],
      ["debt_payments_student_loan_payment", 21000],
      ["utilities_internet", 8000],
      ["utilities_electric_and_gas", 14000],
      ["utilities_phone", 12000],
      ["utilities_water_sewer_and_trash", 6500],
      ["lifestyle_streaming_and_subscriptions", 3000],
      ["health_fitness", 4500],
    ];
    for (const [slug, amt] of lines) db.insert(schema.budgetLines).values({ id: `${id}-${slug}`, budgetMonthId: id, categoryId: catId(HH, slug), amount: amt }).run();
    db.insert(schema.budgetLines).values({ id: `${id}-dining`, budgetMonthId: id, categoryId: catId(HH, "food_restaurants_and_takeout"), amount: 30000 }).run();
    db.insert(schema.budgetLines).values({ id: `${id}-groc`, budgetMonthId: id, categoryId: catId(HH, "food_groceries"), amount: 80000 }).run();
  }

  // Sinking funds.
  const funds = [
    { id: "f-ins", name: "Car insurance", cats: ["transportation_auto_insurance"], target: 78000, due: addMonthsToDate(`${addMonths(start.slice(0, 7), 8)}-10`, 6), rec: "semiannual" as const, bal: 39000 },
    { id: "f-travel", name: "Travel", cats: ["travel_vacation", "travel_flights", "travel_lodging"], target: 300000, due: `${addMonths(thisMonth, 7)}-01`, rec: "annual" as const, bal: 85000 },
    { id: "f-gifts", name: "Holidays & gifts", cats: ["giving_gifts", "giving_holidays"], target: 150000, due: `${today.slice(0, 4)}-12-15`, rec: "annual" as const, bal: 110000 },
    { id: "f-car", name: "Car maintenance", cats: ["transportation_car_maintenance"], target: 90000, due: `${addMonths(thisMonth, 10)}-01`, rec: "annual" as const, bal: 30000 },
    { id: "f-home", name: "Home maintenance", cats: ["housing_home_maintenance_and_repairs"], target: 465000, due: `${addMonths(thisMonth, 12)}-01`, rec: "annual" as const, bal: 120000 },
    { id: "f-prime", name: "Annual memberships", cats: ["lifestyle_annual_memberships"], target: 25000, due: `${addMonths(thisMonth, 11)}-08`, rec: "annual" as const, bal: 2000 },
  ];
  for (const f of funds) {
    db.insert(schema.sinkingFunds).values({ id: f.id, householdId: HH, name: f.name, categoryIds: f.cats.map((c) => catId(HH, c)), target: f.target, nextDue: f.due, recurrence: f.rec, backingAccountId: "hysa" }).run();
    db.insert(schema.sinkingFundLedger).values({ id: `${f.id}-start`, fundId: f.id, date: start, amount: f.bal + (f.id === "f-travel" ? 209700 : f.id === "f-ins" ? 156000 : f.id === "f-car" ? 42500 : f.id === "f-prime" ? 13900 : 0), kind: "adjustment", note: "Starting balance" }).run();
  }

  // Goals.
  db.insert(schema.goals).values({ id: "g-ef", householdId: HH, name: "Emergency fund", type: "emergency_fund", target: 2400000, priority: 1, linkedAccountIds: ["hysa"], startingBalance: 0 }).run();
  db.insert(schema.goals).values({ id: "g-kitchen", householdId: HH, name: "Kitchen remodel", type: "savings", target: 2500000, priority: 2, targetDate: `${addMonths(thisMonth, 20)}-01`, manualProgress: 450000 }).run();

  for (const k of ["values", "joint_checking", "fun_money"]) db.insert(schema.mergeMilestones).values({ householdId: HH, key: k, doneAt: new Date().toISOString() }).run();
  // Close two months ago.
  db.insert(schema.monthCloses).values({ householdId: HH, month: addMonths(thisMonth, -2), closedAt: new Date().toISOString(), closedBy: "demo-user-a" }).run();

  console.log(`Demo household created with ${inserted} transactions. Login alex@demo.local / demo-password-123`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

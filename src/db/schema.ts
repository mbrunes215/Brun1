import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const createdAt = () => text("created_at").notNull().default(sql`(datetime('now'))`);

// ---------------- Identity ----------------

export const households = sqliteTable("households", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  /** JSON: SplitPolicy */
  splitPolicy: text("split_policy", { mode: "json" }).$type<Record<string, unknown>>(),
  settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().default({}),
  createdAt: createdAt(),
});

export const users = sqliteTable("users", {
  id: id(),
  householdId: text("household_id").notNull().references(() => households.id),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  /** Which partner slot this user occupies: A or B. */
  slot: text("slot", { enum: ["A", "B"] }).notNull(),
  passwordHash: text("password_hash").notNull(),
  totpSecret: text("totp_secret"), // encrypted
  totpEnabled: integer("totp_enabled", { mode: "boolean" }).notNull().default(false),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const sessions = sqliteTable("sessions", {
  id: id(), // sha256 of the token
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
  /** False until the second factor has been verified. */
  mfaPassed: integer("mfa_passed", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const invites = sqliteTable("invites", {
  id: id(), // sha256 of the token
  householdId: text("household_id").notNull(),
  createdBy: text("created_by").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: text("used_at"),
});

// ---------------- Accounts ----------------

export const connections = sqliteTable("connections", {
  id: id(),
  householdId: text("household_id").notNull(),
  provider: text("provider", { enum: ["simplefin"] }).notNull(),
  accessUrlEnc: text("access_url_enc").notNull(),
  label: text("label"),
  lastSyncedAt: text("last_synced_at"),
  lastError: text("last_error"),
  createdAt: createdAt(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: id(),
    householdId: text("household_id").notNull(),
    connectionId: text("connection_id"),
    externalId: text("external_id"),
    name: text("name").notNull(),
    institution: text("institution"),
    type: text("type").notNull(),
    owner: text("owner", { enum: ["A", "B", "joint"] }).notNull().default("joint"),
    balance: integer("balance").notNull().default(0),
    balanceDate: text("balance_date"),
    /** Balance as reported by the bank at last sync (for reconciliation). */
    reportedBalance: integer("reported_balance"),
    creditLimit: integer("credit_limit"),
    apr: real("apr"),
    minPayment: integer("min_payment"),
    promoAprEnd: text("promo_apr_end"),
    statementCloseDay: integer("statement_close_day"),
    taxBucket: text("tax_bucket"),
    liquidity: text("liquidity"),
    isManual: integer("is_manual", { mode: "boolean" }).notNull().default(false),
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false),
    excludeFromCashFlow: integer("exclude_from_cash_flow", { mode: "boolean" }).notNull().default(false),
    /** Manual assets: annual appreciation (+) or depreciation (-) rate. */
    valueChangeRate: real("value_change_rate"),
    /** Mortgage/HELOC -> property account for home equity. */
    linkedAssetId: text("linked_asset_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("accounts_ext").on(t.connectionId, t.externalId)],
);

export const balanceSnapshots = sqliteTable(
  "balance_snapshots",
  {
    accountId: text("account_id").notNull(),
    date: text("date").notNull(),
    balance: integer("balance").notNull(),
  },
  (t) => [uniqueIndex("snap_acct_date").on(t.accountId, t.date)],
);

export const holdings = sqliteTable("holdings", {
  id: id(),
  accountId: text("account_id").notNull(),
  symbol: text("symbol"),
  description: text("description"),
  shares: real("shares"),
  costBasis: integer("cost_basis"),
  marketValue: integer("market_value").notNull(),
  assetClass: text("asset_class"), // us_stock, intl_stock, bond, cash, real_estate, other
  asOf: text("as_of").notNull(),
});

// ---------------- Categories & transactions ----------------

export const categories = sqliteTable("categories", {
  id: id(),
  householdId: text("household_id").notNull(),
  name: text("name").notNull(),
  group: text("group_name").notNull(),
  budgetType: text("budget_type").notNull(),
  essential: integer("essential", { mode: "boolean" }).notNull().default(false),
  isTransferLike: integer("is_transfer_like", { mode: "boolean" }).notNull().default(false),
  isPersonalAllowance: integer("is_personal_allowance", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const transactions = sqliteTable(
  "transactions",
  {
    id: id(),
    householdId: text("household_id").notNull(),
    accountId: text("account_id").notNull(),
    externalId: text("external_id"),
    source: text("source", { enum: ["simplefin", "csv", "ofx", "manual"] }).notNull(),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    payeeRaw: text("payee_raw").notNull(),
    merchant: text("merchant"),
    categoryId: text("category_id"),
    categorySource: text("category_source"), // rule | memory | provider | user | none
    owner: text("owner", { enum: ["A", "B", "joint"] }),
    isShared: integer("is_shared", { mode: "boolean" }).notNull().default(false),
    isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
    isTransfer: integer("is_transfer", { mode: "boolean" }).notNull().default(false),
    transferPairId: text("transfer_pair_id"),
    transferSuggestedPairId: text("transfer_suggested_pair_id"),
    isReimbursable: integer("is_reimbursable", { mode: "boolean" }).notNull().default(false),
    reimbursementOfId: text("reimbursement_of_id"),
    refundOfId: text("refund_of_id"),
    isSettlement: integer("is_settlement", { mode: "boolean" }).notNull().default(false),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false),
    possibleDuplicateOf: text("possible_duplicate_of"),
    tags: text("tags", { mode: "json" }).$type<string[]>().default([]),
    notes: text("notes"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: text("reviewed_at"),
    createdBy: text("created_by"),
    updatedAt: text("updated_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("txn_date").on(t.householdId, t.date),
    index("txn_acct").on(t.accountId, t.date),
    uniqueIndex("txn_ext").on(t.accountId, t.externalId),
  ],
);

export const transactionSplits = sqliteTable("transaction_splits", {
  id: id(),
  transactionId: text("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  categoryId: text("category_id"),
  owner: text("owner", { enum: ["A", "B", "joint"] }),
  tags: text("tags", { mode: "json" }).$type<string[]>().default([]),
  notes: text("notes"),
});

export const rules = sqliteTable("rules", {
  id: id(),
  householdId: text("household_id").notNull(),
  name: text("name"),
  priority: integer("priority").notNull().default(100),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  conditions: text("conditions", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  actions: text("actions", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

export const merchantMemory = sqliteTable(
  "merchant_memory",
  {
    householdId: text("household_id").notNull(),
    merchantKey: text("merchant_key").notNull(),
    categoryId: text("category_id").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("mm_key").on(t.householdId, t.merchantKey)],
);

// ---------------- Budgeting ----------------

export const budgetMonths = sqliteTable(
  "budget_months",
  {
    id: id(),
    householdId: text("household_id").notNull(),
    month: text("month").notNull(),
    expectedIncome: integer("expected_income").notNull().default(0),
    flexTotal: integer("flex_total"),
    flexRollover: integer("flex_rollover", { mode: "boolean" }).notNull().default(false),
    savingsGoals: integer("savings_goals").notNull().default(0),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("bm_month").on(t.householdId, t.month)],
);

export const budgetLines = sqliteTable(
  "budget_lines",
  {
    id: id(),
    budgetMonthId: text("budget_month_id").notNull().references(() => budgetMonths.id, { onDelete: "cascade" }),
    categoryId: text("category_id").notNull(),
    amount: integer("amount").notNull(),
    rollover: integer("rollover", { mode: "boolean" }).notNull().default(false),
    varianceNote: text("variance_note"),
  },
  (t) => [uniqueIndex("bl_cat").on(t.budgetMonthId, t.categoryId)],
);

export const sinkingFunds = sqliteTable("sinking_funds", {
  id: id(),
  householdId: text("household_id").notNull(),
  name: text("name").notNull(),
  categoryIds: text("category_ids", { mode: "json" }).$type<string[]>().notNull(),
  target: integer("target").notNull(),
  nextDue: text("next_due").notNull(),
  recurrence: text("recurrence", { enum: ["none", "annual", "semiannual", "quarterly"] }).notNull(),
  backingAccountId: text("backing_account_id"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
});

export const sinkingFundLedger = sqliteTable("sinking_fund_ledger", {
  id: id(),
  fundId: text("fund_id").notNull().references(() => sinkingFunds.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  amount: integer("amount").notNull(),
  kind: text("kind", { enum: ["contribution", "draw", "adjustment"] }).notNull(),
  txnId: text("txn_id"),
  note: text("note"),
});

export const recurringSeries = sqliteTable("recurring_series", {
  key: text("key").primaryKey(),
  householdId: text("household_id").notNull(),
  status: text("status", { enum: ["detected", "confirmed", "dismissed", "cancelled"] }).notNull().default("detected"),
  label: text("label"),
  updatedAt: text("updated_at"),
});

// ---------------- Income, goals, couple ----------------

export const paychecks = sqliteTable("paychecks", {
  id: id(),
  householdId: text("household_id").notNull(),
  owner: text("owner", { enum: ["A", "B"] }).notNull(),
  employer: text("employer").notNull(),
  frequency: text("frequency", { enum: ["weekly", "biweekly", "semimonthly", "monthly"] }).notNull(),
  gross: integer("gross").notNull(),
  pretax: text("pretax", { mode: "json" }).$type<Array<{ label: string; kind: string; amount: number }>>().notNull(),
  taxes: integer("taxes").notNull(),
  posttax: text("posttax", { mode: "json" }).$type<Array<{ label: string; kind: string; amount: number }>>().notNull(),
  employerContrib: integer("employer_contrib").notNull().default(0),
  net: integer("net").notNull(),
  depositAccountId: text("deposit_account_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const goals = sqliteTable("goals", {
  id: id(),
  householdId: text("household_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  target: integer("target").notNull(),
  targetDate: text("target_date"),
  priority: integer("priority").notNull().default(10),
  linkedAccountIds: text("linked_account_ids", { mode: "json" }).$type<string[]>().default([]),
  /** Progress counted from this balance (so existing savings can be excluded). */
  startingBalance: integer("starting_balance").notNull().default(0),
  manualProgress: integer("manual_progress").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const settlements = sqliteTable("settlements", {
  id: id(),
  householdId: text("household_id").notNull(),
  date: text("date").notNull(),
  from: text("from_slot", { enum: ["A", "B"] }).notNull(),
  to: text("to_slot", { enum: ["A", "B"] }).notNull(),
  amount: integer("amount").notNull(),
  txnId: text("txn_id"),
  note: text("note"),
});

export const mergeMilestones = sqliteTable("merge_milestones", {
  householdId: text("household_id").notNull(),
  key: text("key").notNull(),
  doneAt: text("done_at"),
  note: text("note"),
});

// ---------------- Ops ----------------

export const monthCloses = sqliteTable(
  "month_closes",
  {
    householdId: text("household_id").notNull(),
    month: text("month").notNull(),
    closedAt: text("closed_at").notNull(),
    closedBy: text("closed_by").notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("mc_month").on(t.householdId, t.month)],
);

export const alerts = sqliteTable("alerts", {
  id: id(),
  householdId: text("household_id").notNull(),
  userSlot: text("user_slot"), // null = both
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  dedupeKey: text("dedupe_key").notNull(),
  createdAt: createdAt(),
  readAt: text("read_at"),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  householdId: text("household_id").notNull(),
  userId: text("user_id"),
  action: text("action").notNull(),
  entity: text("entity"),
  entityId: text("entity_id"),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>(),
  at: createdAt(),
});

export const contributionLimits = sqliteTable(
  "contribution_limits",
  {
    year: integer("year").notNull(),
    key: text("key").notNull(),
    amount: integer("amount").notNull(),
    source: text("source"),
  },
  (t) => [uniqueIndex("cl_year_key").on(t.year, t.key)],
);

export const jobLocks = sqliteTable("job_locks", {
  name: text("name").primaryKey(),
  lockedUntil: integer("locked_until").notNull(),
  lastRunAt: text("last_run_at"),
  lastResult: text("last_result"),
});

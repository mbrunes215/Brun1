CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`connection_id` text,
	`external_id` text,
	`name` text NOT NULL,
	`institution` text,
	`type` text NOT NULL,
	`owner` text DEFAULT 'joint' NOT NULL,
	`balance` integer DEFAULT 0 NOT NULL,
	`balance_date` text,
	`reported_balance` integer,
	`credit_limit` integer,
	`apr` real,
	`min_payment` integer,
	`promo_apr_end` text,
	`statement_close_day` integer,
	`tax_bucket` text,
	`liquidity` text,
	`is_manual` integer DEFAULT false NOT NULL,
	`is_hidden` integer DEFAULT false NOT NULL,
	`exclude_from_cash_flow` integer DEFAULT false NOT NULL,
	`value_change_rate` real,
	`linked_asset_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_ext` ON `accounts` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_slot` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`entity` text,
	`entity_id` text,
	`detail` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`balance` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snap_acct_date` ON `balance_snapshots` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `budget_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`budget_month_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount` integer NOT NULL,
	`rollover` integer DEFAULT false NOT NULL,
	`variance_note` text,
	FOREIGN KEY (`budget_month_id`) REFERENCES `budget_months`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bl_cat` ON `budget_lines` (`budget_month_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `budget_months` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`month` text NOT NULL,
	`expected_income` integer DEFAULT 0 NOT NULL,
	`flex_total` integer,
	`flex_rollover` integer DEFAULT false NOT NULL,
	`savings_goals` integer DEFAULT 0 NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bm_month` ON `budget_months` (`household_id`,`month`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`group_name` text NOT NULL,
	`budget_type` text NOT NULL,
	`essential` integer DEFAULT false NOT NULL,
	`is_transfer_like` integer DEFAULT false NOT NULL,
	`is_personal_allowance` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`provider` text NOT NULL,
	`access_url_enc` text NOT NULL,
	`label` text,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contribution_limits` (
	`year` integer NOT NULL,
	`key` text NOT NULL,
	`amount` integer NOT NULL,
	`source` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cl_year_key` ON `contribution_limits` (`year`,`key`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`target` integer NOT NULL,
	`target_date` text,
	`priority` integer DEFAULT 10 NOT NULL,
	`linked_account_ids` text DEFAULT '[]',
	`starting_balance` integer DEFAULT 0 NOT NULL,
	`manual_progress` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`symbol` text,
	`description` text,
	`shares` real,
	`cost_basis` integer,
	`market_value` integer NOT NULL,
	`asset_class` text,
	`as_of` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`split_policy` text,
	`settings` text DEFAULT '{}',
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE TABLE `job_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`locked_until` integer NOT NULL,
	`last_run_at` text,
	`last_result` text
);
--> statement-breakpoint
CREATE TABLE `merchant_memory` (
	`household_id` text NOT NULL,
	`merchant_key` text NOT NULL,
	`category_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mm_key` ON `merchant_memory` (`household_id`,`merchant_key`);--> statement-breakpoint
CREATE TABLE `merge_milestones` (
	`household_id` text NOT NULL,
	`key` text NOT NULL,
	`done_at` text,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `month_closes` (
	`household_id` text NOT NULL,
	`month` text NOT NULL,
	`closed_at` text NOT NULL,
	`closed_by` text NOT NULL,
	`snapshot` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mc_month` ON `month_closes` (`household_id`,`month`);--> statement-breakpoint
CREATE TABLE `paychecks` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`owner` text NOT NULL,
	`employer` text NOT NULL,
	`frequency` text NOT NULL,
	`gross` integer NOT NULL,
	`pretax` text NOT NULL,
	`taxes` integer NOT NULL,
	`posttax` text NOT NULL,
	`employer_contrib` integer DEFAULT 0 NOT NULL,
	`net` integer NOT NULL,
	`deposit_account_id` text,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring_series` (
	`key` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`status` text DEFAULT 'detected' NOT NULL,
	`label` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`mfa_passed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`date` text NOT NULL,
	`from_slot` text NOT NULL,
	`to_slot` text NOT NULL,
	`amount` integer NOT NULL,
	`txn_id` text,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `sinking_fund_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`fund_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`kind` text NOT NULL,
	`txn_id` text,
	`note` text,
	FOREIGN KEY (`fund_id`) REFERENCES `sinking_funds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sinking_funds` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`category_ids` text NOT NULL,
	`target` integer NOT NULL,
	`next_due` text NOT NULL,
	`recurrence` text NOT NULL,
	`backing_account_id` text,
	`archived` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`amount` integer NOT NULL,
	`category_id` text,
	`owner` text,
	`tags` text DEFAULT '[]',
	`notes` text,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`account_id` text NOT NULL,
	`external_id` text,
	`source` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`payee_raw` text NOT NULL,
	`merchant` text,
	`category_id` text,
	`category_source` text,
	`owner` text,
	`is_shared` integer DEFAULT false NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`is_transfer` integer DEFAULT false NOT NULL,
	`transfer_pair_id` text,
	`transfer_suggested_pair_id` text,
	`is_reimbursable` integer DEFAULT false NOT NULL,
	`reimbursement_of_id` text,
	`refund_of_id` text,
	`is_settlement` integer DEFAULT false NOT NULL,
	`pending` integer DEFAULT false NOT NULL,
	`is_hidden` integer DEFAULT false NOT NULL,
	`possible_duplicate_of` text,
	`tags` text DEFAULT '[]',
	`notes` text,
	`reviewed_by` text,
	`reviewed_at` text,
	`created_by` text,
	`updated_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `txn_date` ON `transactions` (`household_id`,`date`);--> statement-breakpoint
CREATE INDEX `txn_acct` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `txn_ext` ON `transactions` (`account_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`slot` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
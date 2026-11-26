-- Migration: bank statements, bronze layer (ICBC API JSON)
--
-- Append-only. Input is always the ICBC API JSON; the monthly PDFs before the
-- API window are converted once to that JSON (scripts/icbc-pdf-to-json.ts),
-- with an invented transaction_number and the PDF line kept in `raw`.
-- A row seen again with identical content is not repeated; if the bank changes
-- it, it is added as the next version. Triggers block UPDATE and DELETE.
--
-- Idempotent on purpose: migrations are applied by hand in production
-- (drizzle migration tracking is out of sync there).

CREATE TABLE IF NOT EXISTS `bank_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source` text NOT NULL,
	`filename` text NOT NULL,
	`sha256` text NOT NULL,
	`account` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`row_count` integer NOT NULL,
	`new_count` integer NOT NULL,
	`imported_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_bank_import_sha` ON `bank_imports` (`sha256`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bank_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`import_id` integer NOT NULL,
	`source` text NOT NULL,
	`account` text NOT NULL,
	`transaction_number` integer NOT NULL,
	`version` integer NOT NULL,
	`content_hash` text NOT NULL,
	`date` text NOT NULL,
	`value_date` text,
	`operated_at` text,
	`concept` text NOT NULL,
	`concept_code` text,
	`ticket` text,
	`amount` real NOT NULL,
	`balance` real NOT NULL,
	`channel` text,
	`counterpart_name` text,
	`counterpart_tax_id` text,
	`counterpart_cbu` text,
	`counterpart_bank` text,
	`reason_code` text,
	`reason` text,
	`raw` text NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `bank_imports`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `unique_bank_movement_version` ON `bank_movements` (`account`, `transaction_number`, `version`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bank_movements_date` ON `bank_movements` (`date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bank_movements_ticket` ON `bank_movements` (`ticket`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bank_movements_import` ON `bank_movements` (`import_id`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_bank_imports_no_update` BEFORE UPDATE ON `bank_imports`
BEGIN SELECT RAISE(ABORT, 'bank_imports is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_bank_imports_no_delete` BEFORE DELETE ON `bank_imports`
BEGIN SELECT RAISE(ABORT, 'bank_imports is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_bank_movements_no_update` BEFORE UPDATE ON `bank_movements`
BEGIN SELECT RAISE(ABORT, 'bank_movements is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_bank_movements_no_delete` BEFORE DELETE ON `bank_movements`
BEGIN SELECT RAISE(ABORT, 'bank_movements is immutable'); END;

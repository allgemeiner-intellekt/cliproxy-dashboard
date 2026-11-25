CREATE TABLE `usage_rollup` (
	`slot` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`account_label` text NOT NULL,
	`client_key_hash` text NOT NULL,
	`client_ip` text NOT NULL,
	`records` integer NOT NULL,
	`unpriced_records` integer NOT NULL,
	`cost_micros` integer NOT NULL,
	`cache_savings_micros` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	PRIMARY KEY(`slot`, `provider`, `model`, `account_label`, `client_key_hash`, `client_ip`)
);
--> statement-breakpoint
CREATE TABLE `usage_sessions` (
	`tool` text NOT NULL,
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`tool`, `session_id`, `provider`, `model`)
);
--> statement-breakpoint
CREATE INDEX `usage_sessions_last_at` ON `usage_sessions` (`last_at`);--> statement-breakpoint
CREATE INDEX `requests_session` ON `requests` (`session_id`);
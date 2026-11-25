DROP TABLE `key_labels`;--> statement-breakpoint
DROP TABLE `pool_peers`;--> statement-breakpoint
DROP TABLE `pool_sharing`;--> statement-breakpoint
DROP TABLE `price_overrides`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
DROP INDEX `requests_model`;--> statement-breakpoint
CREATE INDEX `requests_source` ON `requests` (`source`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `requests_unpriced` ON `requests` (`model`) WHERE cost_micros IS NULL OR cache_savings_micros IS NULL;
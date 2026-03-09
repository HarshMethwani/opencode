ALTER TABLE `finding` ADD `confidence` text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE `finding` ADD `invariant` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `finding` ADD `locations` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `finding` ADD `trace` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `finding` ADD `poc_file` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `finding` ADD `category` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `finding_category_idx` ON `finding` (`category`);
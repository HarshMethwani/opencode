CREATE TABLE `finding` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`impact` text DEFAULT '' NOT NULL,
	`contracts` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`poc_status` text DEFAULT 'none' NOT NULL,
	`recommendation` text DEFAULT '' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_finding_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `scope` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`language` text DEFAULT 'solidity' NOT NULL,
	`audit_status` text DEFAULT 'pending' NOT NULL,
	`findings_count` integer DEFAULT 0 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_scope_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `finding_session_idx` ON `finding` (`session_id`);--> statement-breakpoint
CREATE INDEX `finding_severity_idx` ON `finding` (`severity`);--> statement-breakpoint
CREATE INDEX `scope_session_idx` ON `scope` (`session_id`);--> statement-breakpoint
CREATE INDEX `scope_path_idx` ON `scope` (`path`);
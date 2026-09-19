ALTER TABLE "backups" ADD COLUMN "offsite" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "offsite_error" text DEFAULT '' NOT NULL;
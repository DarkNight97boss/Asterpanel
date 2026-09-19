ALTER TABLE "invoices" ADD COLUMN "sdi_provider" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sdi_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sdi_status" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sdi_message" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sdi_sent_at" timestamp with time zone;
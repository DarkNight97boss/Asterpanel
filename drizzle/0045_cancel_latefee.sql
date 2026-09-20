ALTER TABLE "invoices" ADD COLUMN "late_fee_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "cancel_reason" text DEFAULT '' NOT NULL;
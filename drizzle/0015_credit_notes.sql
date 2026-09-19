ALTER TABLE "invoices" ADD COLUMN "kind" text DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credits_invoice_id" uuid;
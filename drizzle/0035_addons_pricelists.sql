ALTER TABLE "companies" ADD COLUMN "discount_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "addons" jsonb DEFAULT '[]'::jsonb NOT NULL;
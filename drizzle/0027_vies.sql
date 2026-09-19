ALTER TABLE "companies" ADD COLUMN "vat_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "vat_validated_name" text DEFAULT '' NOT NULL;
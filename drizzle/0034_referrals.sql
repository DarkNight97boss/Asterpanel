ALTER TABLE "companies" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "referred_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_referral_code_unique" UNIQUE("referral_code");
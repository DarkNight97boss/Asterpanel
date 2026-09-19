CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"org_type" text DEFAULT 'company' NOT NULL,
	"billing_name" text DEFAULT '' NOT NULL,
	"tax_code" text DEFAULT '' NOT NULL,
	"vat_id" text DEFAULT '' NOT NULL,
	"address1" text DEFAULT '' NOT NULL,
	"address2" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"zip" text DEFAULT '' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"workload_ids" jsonb,
	"invite_token_hash" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dns_zones" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "workloads" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_member_email_idx" ON "company_members" USING btree ("company_id","email");--> statement-breakpoint
CREATE INDEX "company_member_user_idx" ON "company_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Backfill: every user that owns something (or is a client) gets a company built from their profile.
INSERT INTO "companies" ("id", "name", "org_type", "billing_name", "vat_id", "address1", "city", "zip", "state", "country")
SELECT u."id",
       COALESCE(NULLIF(u."company", ''), NULLIF(TRIM(u."first_name" || ' ' || u."last_name"), ''), u."email"),
       CASE WHEN u."company" = '' THEN 'individual' ELSE 'company' END,
       u."company", u."vat_id", u."address", u."city", u."zip", u."state", u."country"
FROM "users" u
WHERE u."role" = 'client'
   OR EXISTS (SELECT 1 FROM "workloads" w WHERE w."client_id" = u."id")
   OR EXISTS (SELECT 1 FROM "invoices" i WHERE i."client_id" = u."id")
   OR EXISTS (SELECT 1 FROM "services" s WHERE s."client_id" = u."id")
   OR EXISTS (SELECT 1 FROM "tickets" t WHERE t."client_id" = u."id");
--> statement-breakpoint
-- The backfilled company reuses the user's id, which makes the ownership update a plain copy.
INSERT INTO "company_members" ("company_id", "user_id", "email", "role", "accepted_at")
SELECT c."id", u."id", u."email", 'owner', now() FROM "companies" c JOIN "users" u ON u."id" = c."id";
--> statement-breakpoint
UPDATE "workloads" SET "company_id" = "client_id" WHERE "company_id" IS NULL AND "client_id" IN (SELECT "id" FROM "companies");
--> statement-breakpoint
UPDATE "services" SET "company_id" = "client_id" WHERE "company_id" IS NULL AND "client_id" IN (SELECT "id" FROM "companies");
--> statement-breakpoint
UPDATE "invoices" SET "company_id" = "client_id" WHERE "company_id" IS NULL AND "client_id" IN (SELECT "id" FROM "companies");
--> statement-breakpoint
UPDATE "orders" SET "company_id" = "client_id" WHERE "company_id" IS NULL AND "client_id" IN (SELECT "id" FROM "companies");
--> statement-breakpoint
UPDATE "tickets" SET "company_id" = "client_id" WHERE "company_id" IS NULL AND "client_id" IN (SELECT "id" FROM "companies");
--> statement-breakpoint
UPDATE "dns_zones" SET "company_id" = "client_id" WHERE "company_id" IS NULL AND "client_id" IN (SELECT "id" FROM "companies");
--> statement-breakpoint
-- Accepted legacy team memberships become company memberships.
INSERT INTO "company_members" ("company_id", "user_id", "email", "role", "workload_ids", "accepted_at")
SELECT tm."owner_id", tm."member_id", tm."email", tm."role", tm."workload_ids", tm."accepted_at"
FROM "team_members" tm
WHERE tm."accepted_at" IS NOT NULL AND tm."owner_id" IN (SELECT "id" FROM "companies")
ON CONFLICT DO NOTHING;

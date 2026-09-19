CREATE TABLE "domain_names" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"client_id" uuid NOT NULL,
	"service_id" uuid,
	"name" text NOT NULL,
	"registrar" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"nameservers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"locked" boolean DEFAULT true NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_names_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "domain_tlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tld" text NOT NULL,
	"registrar" text NOT NULL,
	"register_price" integer NOT NULL,
	"renew_price" integer NOT NULL,
	"transfer_price" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "domain_tlds_tld_unique" UNIQUE("tld")
);
--> statement-breakpoint
ALTER TABLE "domain_names" ADD CONSTRAINT "domain_names_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_names" ADD CONSTRAINT "domain_names_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_names" ADD CONSTRAINT "domain_names_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_names_company_idx" ON "domain_names" USING btree ("company_id");
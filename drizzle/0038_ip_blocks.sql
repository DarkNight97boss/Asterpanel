CREATE TABLE "ip_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text DEFAULT 'ipxo' NOT NULL,
	"cidr" text NOT NULL,
	"subscription_ref" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"asn" integer,
	"loa_status" text DEFAULT 'none' NOT NULL,
	"renews_at" timestamp with time zone,
	"pool_id" uuid,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_blocks_cidr_unique" UNIQUE("cidr")
);
--> statement-breakpoint
ALTER TABLE "ip_blocks" ADD CONSTRAINT "ip_blocks_pool_id_ip_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."ip_pools"("id") ON DELETE set null ON UPDATE no action;
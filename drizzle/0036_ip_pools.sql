CREATE TABLE "ip_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"address" text NOT NULL,
	"provider_ref" text DEFAULT '' NOT NULL,
	"node_id" uuid,
	"leased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_leases_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "ip_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"mode" text NOT NULL,
	"cidr" text DEFAULT '' NOT NULL,
	"auto_lease" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ip_leases" ADD CONSTRAINT "ip_leases_pool_id_ip_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."ip_pools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_leases" ADD CONSTRAINT "ip_leases_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ip_leases_pool_idx" ON "ip_leases" USING btree ("pool_id");
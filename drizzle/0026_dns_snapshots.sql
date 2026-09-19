CREATE TABLE "dns_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_snapshots" ADD CONSTRAINT "dns_snapshots_zone_id_dns_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."dns_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_snapshots_zone_idx" ON "dns_snapshots" USING btree ("zone_id");
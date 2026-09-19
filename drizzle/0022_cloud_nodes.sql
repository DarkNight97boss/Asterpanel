ALTER TABLE "nodes" ADD COLUMN "provider" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "provider_server_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "provider_region" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "provider_size" text DEFAULT '' NOT NULL;
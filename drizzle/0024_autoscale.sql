ALTER TABLE "nodes" ADD COLUMN "autoscaled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "empty_since" timestamp with time zone;
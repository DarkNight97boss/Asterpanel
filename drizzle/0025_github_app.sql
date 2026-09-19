ALTER TABLE "workloads" ADD COLUMN "github_installation_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workloads" ADD COLUMN "github_repo" text DEFAULT '' NOT NULL;
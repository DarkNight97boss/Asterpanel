CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workload_id" uuid NOT NULL,
	"kind" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workload_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"commit_sha" text DEFAULT '' NOT NULL,
	"commit_message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workload_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"workload_id" uuid,
	"backup_id" uuid,
	"deployment_id" uuid,
	"type" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"actor_id" uuid,
	"error" text DEFAULT '' NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"base_domain" text DEFAULT '' NOT NULL,
	"public_ip" text DEFAULT '' NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"driver" text DEFAULT '' NOT NULL,
	"agent_version" text DEFAULT '' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_workloads" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"service_id" uuid,
	"parent_id" uuid,
	"type" text NOT NULL,
	"environment" text DEFAULT 'live' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"status_message" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text DEFAULT '' NOT NULL,
	"runtime" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deploy_hook_token" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_workload_id_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."workloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_workload_id_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."workloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_workload_id_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."workloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workload_id_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."workloads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workloads" ADD CONSTRAINT "workloads_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_workload_idx" ON "backups" USING btree ("workload_id");--> statement-breakpoint
CREATE INDEX "deployments_workload_idx" ON "deployments" USING btree ("workload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_hostname_idx" ON "domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "domains_workload_idx" ON "domains" USING btree ("workload_id");--> statement-breakpoint
CREATE INDEX "jobs_node_status_idx" ON "jobs" USING btree ("node_id","status");--> statement-breakpoint
CREATE INDEX "jobs_workload_idx" ON "jobs" USING btree ("workload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workloads_slug_idx" ON "workloads" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workloads_client_idx" ON "workloads" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "workloads_node_idx" ON "workloads" USING btree ("node_id");
CREATE TABLE "workload_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workload_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu_percent" integer DEFAULT 0 NOT NULL,
	"mem_mb" integer DEFAULT 0 NOT NULL,
	"rx_mb" integer DEFAULT 0 NOT NULL,
	"tx_mb" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workload_metrics" ADD CONSTRAINT "workload_metrics_workload_id_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."workloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workload_metrics_idx" ON "workload_metrics" USING btree ("workload_id","at");
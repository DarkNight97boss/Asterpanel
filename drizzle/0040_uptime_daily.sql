CREATE TABLE "uptime_daily" (
	"workload_id" uuid NOT NULL,
	"day" text NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"up" integer DEFAULT 0 NOT NULL,
	"ms_sum" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "uptime_daily_workload_id_day_pk" PRIMARY KEY("workload_id","day")
);
--> statement-breakpoint
ALTER TABLE "uptime_daily" ADD CONSTRAINT "uptime_daily_workload_id_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."workloads"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "companies" ADD COLUMN "require_2fa" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "format" text DEFAULT 'json' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "chat_id" text DEFAULT '' NOT NULL;
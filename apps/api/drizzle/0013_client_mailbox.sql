ALTER TABLE "contacts" ADD COLUMN "notify_email" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "notify_mode" text DEFAULT 'main' NOT NULL;
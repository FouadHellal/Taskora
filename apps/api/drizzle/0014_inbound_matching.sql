ALTER TABLE "companies" ADD COLUMN "email_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_notes" ADD COLUMN "contact_id" integer;--> statement-breakpoint
ALTER TABLE "ticket_notes" ADD CONSTRAINT "ticket_notes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
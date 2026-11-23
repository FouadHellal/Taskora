ALTER TABLE "attachments" ADD COLUMN "uploaded_by_contact_id" integer;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "portal_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "portal_role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD COLUMN "portal_author_contact_id" integer;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD COLUMN "portal_updated_by_contact_id" integer;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_portal_author_contact_id_contacts_id_fk" FOREIGN KEY ("portal_author_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_portal_updated_by_contact_id_contacts_id_fk" FOREIGN KEY ("portal_updated_by_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
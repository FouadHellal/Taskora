CREATE TABLE "atlas_entities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "atlas_entities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"external_id" text NOT NULL,
	"instance" text NOT NULL,
	"entity_key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"ip_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"mac_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"pve_cluster" text,
	"pve_node" text,
	"vmid" integer,
	"status" text DEFAULT 'unknown' NOT NULL,
	"os_name" text,
	"serial_number" text,
	"link" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"configuration_item_id" integer,
	"match_status" text DEFAULT 'unmatched' NOT NULL,
	"match_note" text,
	"candidate_ci_ids" integer[] DEFAULT '{}'::int[] NOT NULL,
	"previous_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"observed_at" timestamp with time zone,
	"missing_since" timestamp with time zone,
	"decommissioned_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atlas_entities_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "atlas_incident_links" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "atlas_incident_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"external_key" text NOT NULL,
	"instance" text NOT NULL,
	"incident_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"ticket_id" integer,
	"configuration_item_id" integer,
	"entity_key" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"severity" text NOT NULL,
	"persisting" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"link" text,
	"entity" jsonb,
	"last_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_observed_at" timestamp with time zone,
	"last_observed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "atlas_incident_links_external_key_unique" UNIQUE("external_key")
);
--> statement-breakpoint
CREATE TABLE "integration_tokens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "integration_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "integration_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "ci_relations" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_relations" ADD COLUMN "source_detail" text;--> statement-breakpoint
ALTER TABLE "ci_relations" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "atlas_entities" ADD CONSTRAINT "atlas_entities_configuration_item_id_configuration_items_id_fk" FOREIGN KEY ("configuration_item_id") REFERENCES "public"."configuration_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_incident_links" ADD CONSTRAINT "atlas_incident_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atlas_incident_links" ADD CONSTRAINT "atlas_incident_links_configuration_item_id_configuration_items_id_fk" FOREIGN KEY ("configuration_item_id") REFERENCES "public"."configuration_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tokens" ADD CONSTRAINT "integration_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atlas_entities_ci_idx" ON "atlas_entities" USING btree ("configuration_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "atlas_entities_ci_uq" ON "atlas_entities" USING btree ("configuration_item_id") WHERE "atlas_entities"."configuration_item_id" is not null;--> statement-breakpoint
CREATE INDEX "atlas_entities_status_idx" ON "atlas_entities" USING btree ("match_status");--> statement-breakpoint
CREATE INDEX "atlas_links_ticket_idx" ON "atlas_incident_links" USING btree ("ticket_id");
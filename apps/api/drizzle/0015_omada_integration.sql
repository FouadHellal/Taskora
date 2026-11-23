CREATE TABLE "omada_clients" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "omada_clients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"site_id" text NOT NULL,
	"mac" text NOT NULL,
	"device_mac" text,
	"name" text,
	"host_name" text,
	"ip_address" text,
	"vendor" text,
	"os_name" text,
	"device_type" text,
	"wireless" boolean DEFAULT false NOT NULL,
	"ssid" text,
	"network_name" text,
	"rssi" integer,
	"signal_level" integer,
	"snr" integer,
	"wifi_mode" text,
	"channel" integer,
	"radio" text,
	"rx_rate" integer,
	"tx_rate" integer,
	"traffic_down" bigint,
	"traffic_up" bigint,
	"uptime_seconds" integer,
	"switch_port" text,
	"guest" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "omada_devices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "omada_devices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"mac" text NOT NULL,
	"site_id" text NOT NULL,
	"configuration_item_id" integer,
	"kind" text NOT NULL,
	"name" text,
	"model" text,
	"serial_number" text,
	"firmware_version" text,
	"ip_address" text,
	"status" text,
	"status_detail" text,
	"uptime_seconds" integer,
	"cpu_util" integer,
	"mem_util" integer,
	"client_count" integer,
	"client_count_2g" integer,
	"client_count_5g" integer,
	"client_count_6g" integer,
	"uplink_device_name" text,
	"uplink_port" text,
	"link_speed" text,
	"last_seen_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_since" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "omada_devices_mac_unique" UNIQUE("mac")
);
--> statement-breakpoint
CREATE TABLE "omada_sites" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "omada_sites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"company_id" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"device_count" integer DEFAULT 0 NOT NULL,
	"client_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "omada_sites_site_id_unique" UNIQUE("site_id")
);
--> statement-breakpoint
ALTER TABLE "omada_devices" ADD CONSTRAINT "omada_devices_configuration_item_id_configuration_items_id_fk" FOREIGN KEY ("configuration_item_id") REFERENCES "public"."configuration_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "omada_sites" ADD CONSTRAINT "omada_sites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "omada_clients_site_mac_uq" ON "omada_clients" USING btree ("site_id","mac");--> statement-breakpoint
CREATE INDEX "omada_clients_device_idx" ON "omada_clients" USING btree ("device_mac");--> statement-breakpoint
CREATE INDEX "omada_devices_site_idx" ON "omada_devices" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "omada_devices_ci_uq" ON "omada_devices" USING btree ("configuration_item_id") WHERE "omada_devices"."configuration_item_id" is not null;
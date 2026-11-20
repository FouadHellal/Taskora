CREATE TABLE "contract_exclusions" (
	"contract_id" integer NOT NULL,
	"work_type_id" integer NOT NULL,
	CONSTRAINT "contract_exclusions_contract_id_work_type_id_pk" PRIMARY KEY("contract_id","work_type_id")
);
--> statement-breakpoint
ALTER TABLE "contract_services" ADD COLUMN "end_date" date;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "per_ticket_rate" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "contract_id" integer;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "service_period_start" date;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "contract_block_id" integer;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "ticket_id" integer;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "covered_minutes" integer;--> statement-breakpoint
ALTER TABLE "contract_exclusions" ADD CONSTRAINT "contract_exclusions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_exclusions" ADD CONSTRAINT "contract_exclusions_work_type_id_work_types_id_fk" FOREIGN KEY ("work_type_id") REFERENCES "public"."work_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_contract_block_id_contract_blocks_id_fk" FOREIGN KEY ("contract_block_id") REFERENCES "public"."contract_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_contract_idx" ON "invoice_lines" USING btree ("contract_id");
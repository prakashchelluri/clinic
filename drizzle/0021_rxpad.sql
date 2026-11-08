ALTER TABLE "prescription_item" ADD COLUMN "timing" text;
--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "qty" integer;
--> statement-breakpoint
ALTER TABLE "medicine" ADD COLUMN "leaflet_url" text;
--> statement-breakpoint
CREATE TABLE "lab_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"recommendation_id" uuid,
	"document_id" uuid,
	"test" text NOT NULL,
	"value" text NOT NULL,
	"num" real,
	"unit" text,
	"low" real,
	"high" real,
	"flag" text,
	"taken_on" date NOT NULL,
	"note" text,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "lab_result" ADD CONSTRAINT "lab_result_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lab_result" ADD CONSTRAINT "lab_result_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "lab_patient" ON "lab_result" USING btree ("tenant_id","patient_id","test");

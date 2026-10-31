CREATE TABLE "course" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES "public"."patient"("id"),
	"recommendation_id" uuid NOT NULL,
	"procedure_id" uuid REFERENCES "public"."procedure_catalog"("id"),
	"sittings" integer NOT NULL,
	"list_paise" integer NOT NULL,
	"total_paise" integer NOT NULL,
	"locked_at" timestamp with time zone,
	"agreed_by" text
);--> statement-breakpoint
CREATE UNIQUE INDEX "course_rec" ON "course" ("tenant_id", "recommendation_id");--> statement-breakpoint
CREATE INDEX "course_patient" ON "course" ("tenant_id", "patient_id");--> statement-breakpoint
ALTER TABLE "charge" ADD COLUMN "course_id" uuid;--> statement-breakpoint
ALTER TABLE "charge" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "charge" ADD COLUMN "prepaid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "course_id" uuid;

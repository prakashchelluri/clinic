CREATE TABLE "calendar_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practitioner_id" uuid,
	"room_id" uuid,
	"day" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"procedure_session_id" uuid
);
--> statement-breakpoint
CREATE TABLE "procedure_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"procedure_id" uuid,
	"practitioner_id" uuid,
	"room_id" uuid,
	"sitting_no" integer DEFAULT 1 NOT NULL,
	"day" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"state" text DEFAULT 'confirmed' NOT NULL,
	"state_reason" text,
	"notes" text,
	"outcome" jsonb
);
--> statement-breakpoint
CREATE TABLE "room" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "roles" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD COLUMN "required_capability" text;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD COLUMN "buffer_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "kind" text DEFAULT 'clinic' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_block" ADD CONSTRAINT "calendar_block_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_block" ADD CONSTRAINT "calendar_block_practitioner_id_practitioner_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_block" ADD CONSTRAINT "calendar_block_room_id_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."room"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD CONSTRAINT "procedure_session_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD CONSTRAINT "procedure_session_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD CONSTRAINT "procedure_session_procedure_id_procedure_catalog_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedure_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD CONSTRAINT "procedure_session_practitioner_id_practitioner_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD CONSTRAINT "procedure_session_room_id_room_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."room"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room" ADD CONSTRAINT "room_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "block_day" ON "calendar_block" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE INDEX "psession_day" ON "procedure_session" USING btree ("tenant_id","day");
--> statement-breakpoint
UPDATE "app_user" SET "roles" = ARRAY["role"] WHERE cardinality("roles") = 0;

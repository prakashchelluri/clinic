CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"practitioner_id" uuid,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"source" text DEFAULT 'phone' NOT NULL,
	"note" text,
	"overbooked" boolean DEFAULT false NOT NULL,
	"idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE "branch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"address" text
);
--> statement-breakpoint
CREATE TABLE "charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"visit_id" uuid,
	"description" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"adjustment_reason" text,
	"adjusted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "domain_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "domain_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregate" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "encounter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visit_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"practitioner_id" uuid,
	"form_definition_id" uuid NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"completed_at" timestamp with time zone,
	"provenance" jsonb DEFAULT '{"source":"typed"}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"day" date NOT NULL,
	"description" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"method" text DEFAULT 'cash' NOT NULL,
	"entered_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"affects_capacity" boolean DEFAULT true NOT NULL,
	"eligibility" jsonb,
	"eligibility_note" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"specialty_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"schema" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medicine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"form" text,
	"strength" text,
	"schedule_class" text,
	"defaults" jsonb
);
--> statement-breakpoint
CREATE TABLE "numbering_sequence" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_no" text NOT NULL,
	"full_name" text NOT NULL,
	"sex" text,
	"age_years" integer,
	"dob" date,
	"phone" text,
	"locality" text,
	"referral_card" boolean DEFAULT false NOT NULL,
	"allergies" text,
	"notes" text,
	"legacy_id" text,
	"consents" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL,
	"charge_id" uuid,
	"amount_paise" integer NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"received_by" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE "practitioner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"reg_no" text,
	"qualification" text,
	"specialty_id" uuid,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescription_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"encounter_id" uuid NOT NULL,
	"medicine_id" uuid,
	"name" text NOT NULL,
	"dose" text,
	"route" text,
	"frequency" text,
	"duration_days" integer,
	"instructions" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"dispensed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procedure_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"specialty_id" uuid,
	"name" text NOT NULL,
	"typical_minutes" integer DEFAULT 30 NOT NULL,
	"requires_main_doctor" boolean DEFAULT false NOT NULL,
	"requires_review" boolean DEFAULT false NOT NULL,
	"price_paise" integer,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"typical_sittings" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"procedure_id" uuid,
	"due_on" date,
	"sittings" integer,
	"notes" text,
	"status" text DEFAULT 'open' NOT NULL,
	"contact_log" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"branch_id" uuid NOT NULL,
	"practitioner_id" uuid,
	"day" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"capacity" integer NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "specialty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"source_pack" text
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"practitioner_id" uuid,
	"fee_category_id" uuid NOT NULL,
	"day" date NOT NULL,
	"op_number" text NOT NULL,
	"arrived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"queue_position" numeric NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge" ADD CONSTRAINT "charge_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_practitioner_id_practitioner_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter" ADD CONSTRAINT "encounter_form_definition_id_form_definition_id_fk" FOREIGN KEY ("form_definition_id") REFERENCES "public"."form_definition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_category" ADD CONSTRAINT "fee_category_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_definition" ADD CONSTRAINT "form_definition_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_definition" ADD CONSTRAINT "form_definition_specialty_id_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medicine" ADD CONSTRAINT "medicine_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_charge_id_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_specialty_id_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_medicine_id_medicine_id_fk" FOREIGN KEY ("medicine_id") REFERENCES "public"."medicine"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD CONSTRAINT "procedure_catalog_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD CONSTRAINT "procedure_catalog_specialty_id_specialty_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "public"."specialty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_procedure_id_procedure_catalog_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."procedure_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_practitioner_id_practitioner_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialty" ADD CONSTRAINT "specialty_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_practitioner_id_practitioner_id_fk" FOREIGN KEY ("practitioner_id") REFERENCES "public"."practitioner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit" ADD CONSTRAINT "visit_fee_category_id_fee_category_id_fk" FOREIGN KEY ("fee_category_id") REFERENCES "public"."fee_category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_email" ON "app_user" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "appt_idem" ON "appointment" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "enc_patient" ON "encounter" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_code" ON "fee_category" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "numseq_pk" ON "numbering_sequence" USING btree ("tenant_id","key","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_no" ON "patient" USING btree ("tenant_id","patient_no");--> statement-breakpoint
CREATE INDEX "patient_phone" ON "patient" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_idem" ON "payment" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "pay_at" ON "payment" USING btree ("tenant_id","received_at");--> statement-breakpoint
CREATE INDEX "rec_status" ON "recommendation" USING btree ("tenant_id","kind","status");--> statement-breakpoint
CREATE INDEX "session_day" ON "session" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE INDEX "visit_day" ON "visit" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "visit_idem" ON "visit" USING btree ("tenant_id","idempotency_key");
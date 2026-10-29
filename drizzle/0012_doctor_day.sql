CREATE TABLE "rx_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"practitioner_id" uuid,
	"name" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prescription" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX "rx_template_t" ON "rx_template" ("tenant_id", "practitioner_id");--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES "public"."patient"("id"),
	"practitioner_id" uuid,
	"note" text,
	"until_day" date,
	"status" text DEFAULT 'waiting' NOT NULL,
	"offered_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "waitlist_t" ON "waitlist" ("tenant_id", "status");

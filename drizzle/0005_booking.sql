ALTER TABLE "appointment" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "public_token" text;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointment" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appt_token" ON "appointment" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appt_series" ON "appointment" USING btree ("tenant_id","series_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"minutes" integer DEFAULT 60 NOT NULL,
	"price_paise" integer,
	"fee_category_id" uuid,
	"color" text DEFAULT '#3A5A78' NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"places" integer DEFAULT 1 NOT NULL,
	"practitioner_ids" uuid[] DEFAULT '{}' NOT NULL,
	"online_bookable" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid,
	"appointment_id" uuid,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"to_phone" text,
	"body" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provider_ref" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "msg_due" ON "message" USING btree ("status","send_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "msg_appt" ON "message" USING btree ("tenant_id","appointment_id");

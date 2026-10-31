CREATE TABLE "callback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES "public"."patient"("id"),
	"kind" text NOT NULL,
	"ref_id" uuid,
	"outcome" text NOT NULL,
	"note" text,
	"callback_on" date,
	"by_name" text NOT NULL
);--> statement-breakpoint
CREATE INDEX "callback_ref" ON "callback" ("tenant_id", "kind", "ref_id");--> statement-breakpoint
CREATE TABLE "quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"patient_id" uuid NOT NULL REFERENCES "public"."patient"("id"),
	"recommendation_id" uuid NOT NULL,
	"number" text NOT NULL,
	"total_paise" integer NOT NULL,
	"sittings" integer NOT NULL,
	"valid_until" date NOT NULL,
	"extras" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_via" text,
	"sent_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"by_name" text NOT NULL
);--> statement-breakpoint
CREATE INDEX "quote_rec" ON "quote" ("tenant_id", "recommendation_id");--> statement-breakpoint
CREATE TABLE "day_close" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"day" date NOT NULL,
	"closed_by" text NOT NULL,
	"cash_counted_paise" integer,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"diary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "day_close_day" ON "day_close" ("tenant_id", "day");

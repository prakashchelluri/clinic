ALTER TABLE "recommendation" ADD COLUMN "order_no" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "expected_on" date;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "review_outcome" text;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "informed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "informed_how" text;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN "informed_by" text;--> statement-breakpoint
UPDATE "recommendation" SET "received_at" = "created_at", "reviewed_at" = "created_at", "review_outcome" = 'normal', "informed_at" = "created_at" WHERE "kind" = 'investigation' AND "status" = 'done';--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "history" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rx_template" ADD COLUMN "linked" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE "tmpl" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"linked" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" text DEFAULT 'chip' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE INDEX "tmpl_t" ON "tmpl" ("tenant_id", "kind");

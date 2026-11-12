-- Fixed prices: a course costs the list (or a package) price; a discount is an exception on a bill.
-- course.credit_paise: an approved discount on sittings paid ahead; it pays for sittings like the advance but is not money in.
-- discount_ask: a discount above the clinic limit (or from someone without the discount permission), waiting for an approver.
ALTER TABLE "course" ADD COLUMN "credit_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discount_ask" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "patient"("id"),
  "lines" jsonb NOT NULL,
  "list_paise" integer NOT NULL,
  "off_paise" integer NOT NULL,
  "reason" text NOT NULL,
  "asked_by" text NOT NULL,
  "paid_paise" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "decided_by" text,
  "decided_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discount_ask_status" ON "discount_ask" ("tenant_id","status");

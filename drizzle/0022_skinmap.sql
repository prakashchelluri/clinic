CREATE TABLE IF NOT EXISTS "body_pin" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "patient"("id"),
  "encounter_id" uuid REFERENCES "encounter"("id"),
  "side" text DEFAULT 'front' NOT NULL,
  "x" real NOT NULL,
  "y" real NOT NULL,
  "area" text NOT NULL,
  "finding" text,
  "diagnosis" text,
  "resolved_at" timestamp with time zone,
  "created_by" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pin_patient" ON "body_pin" ("tenant_id", "patient_id");
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN IF NOT EXISTS "pin_id" uuid REFERENCES "body_pin"("id");

-- Procedures and packages added from the patient record: the doctor who conducts them, and how long they are valid (or no expiry).
ALTER TABLE "recommendation" ADD COLUMN IF NOT EXISTS "practitioner_id" uuid;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN IF NOT EXISTS "valid_until" date;--> statement-breakpoint
ALTER TABLE "recommendation" ADD COLUMN IF NOT EXISTS "no_expiry" boolean DEFAULT false NOT NULL;

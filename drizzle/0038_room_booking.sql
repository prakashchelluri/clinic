-- A room booked for something other than a procedure (a meeting, cleaning, counselling …): what for, and the patient when there is one.
ALTER TABLE "calendar_block" ADD COLUMN IF NOT EXISTS "purpose" text;--> statement-breakpoint
ALTER TABLE "calendar_block" ADD COLUMN IF NOT EXISTS "patient_id" uuid;

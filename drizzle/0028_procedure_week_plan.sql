-- The coordinator's week plan: each sitting carries the doctor's approval, and a week is sent to the doctors once.
-- draft = not sent yet; sent = with the doctor; approved; change = the doctor sent it back with a note.
-- Sittings booked before this are approved (they were already on the calendar).
ALTER TABLE "procedure_session" ADD COLUMN "approval" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD COLUMN "approval_note" text;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD COLUMN "changed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD COLUMN "booked_by" uuid;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "procedure_week" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "week_start" date NOT NULL,
  "sent_by" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proc_week_start" ON "procedure_week" ("tenant_id","week_start");

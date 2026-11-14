-- A procedure set up in Settings with all its sessions: each session's name, duration, gap after the one before and a note;
-- how it is paid (upfront: the whole total before the first session; per session: each on its day), the total for upfront,
-- the doctor who conducts it, and how long a course of it stays valid.
ALTER TABLE "procedure_catalog" ADD COLUMN IF NOT EXISTS "sessions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD COLUMN IF NOT EXISTS "pricing" text DEFAULT 'per_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD COLUMN IF NOT EXISTS "total_paise" integer;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD COLUMN IF NOT EXISTS "practitioner_id" uuid;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD COLUMN IF NOT EXISTS "valid_for" integer;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD COLUMN IF NOT EXISTS "valid_unit" text;

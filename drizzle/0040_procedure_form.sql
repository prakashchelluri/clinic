-- A procedure session keeps the form version it was filled with (the values stay in outcome) and what it asked the pharmacy for.
ALTER TABLE "procedure_session" ADD COLUMN IF NOT EXISTS "form_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD COLUMN IF NOT EXISTS "supplies" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Each procedure's own consent wording (empty = the standard text) and how long a signed consent lasts before it is asked again (empty = never).
ALTER TABLE "procedure_catalog" ADD COLUMN IF NOT EXISTS "consent_text" text;--> statement-breakpoint
ALTER TABLE "procedure_catalog" ADD COLUMN IF NOT EXISTS "consent_months" integer DEFAULT 12;

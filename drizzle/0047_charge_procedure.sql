-- A charge for a procedure (from the price list, a treatment or a session) names it, so the day's money counts it under Procedures.
ALTER TABLE "charge" ADD COLUMN IF NOT EXISTS "procedure_id" uuid;--> statement-breakpoint
ALTER TABLE "charge" ADD COLUMN IF NOT EXISTS "original_paise" integer;--> statement-breakpoint
UPDATE "charge" c SET "procedure_id" = co."procedure_id" FROM "course" co WHERE c."course_id" = co."id" AND c."procedure_id" IS NULL;--> statement-breakpoint
UPDATE "charge" c SET "procedure_id" = ps."procedure_id" FROM "procedure_session" ps WHERE c."session_id" = ps."id" AND c."procedure_id" IS NULL;

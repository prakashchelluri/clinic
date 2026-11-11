-- Procedure courses over months: the gap between sittings (the next one falls due that many days after the last),
-- the call a week before each sitting, and the day-before WhatsApp reminder tied to its sitting.
ALTER TABLE "recommendation" ADD COLUMN "gap_days" integer;--> statement-breakpoint
ALTER TABLE "procedure_session" ADD COLUMN "week_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "procedure_session_id" uuid;--> statement-breakpoint
CREATE INDEX "msg_sitting" ON "message" USING btree ("tenant_id","procedure_session_id");

ALTER TABLE "document" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "view" text;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "procedure_session_id" uuid;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "taken_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "doc_photo_area" ON "document" USING btree ("tenant_id","patient_id","area");

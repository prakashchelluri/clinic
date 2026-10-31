ALTER TABLE "patient" ADD COLUMN "flags" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "guardian_id" uuid;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "contact_label" text;

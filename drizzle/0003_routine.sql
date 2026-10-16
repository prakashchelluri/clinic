ALTER TABLE "practitioner" ADD COLUMN "routine" jsonb;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;
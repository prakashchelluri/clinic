ALTER TABLE "document" ADD COLUMN "recommendation_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "reviewed_at" timestamp with time zone;

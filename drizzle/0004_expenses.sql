ALTER TABLE "expense" ADD COLUMN "category" text DEFAULT 'Other' NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "voided_reason" text;

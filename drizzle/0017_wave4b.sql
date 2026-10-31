ALTER TABLE "charge" ADD COLUMN "discount_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "charge" ADD COLUMN "discount_reason" text;--> statement-breakpoint
ALTER TABLE "charge" ADD COLUMN "excluded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "charge" ADD COLUMN "excluded_reason" text;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "receipt_no" text;

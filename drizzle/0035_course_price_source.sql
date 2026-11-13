-- Where a course's price came from, for the accounts: the doctor's own amount, a clinic package, or the standard price.
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "price_source" text NOT NULL DEFAULT 'standard';--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "standard_paise" integer;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "price_by" text;

-- Prescribing safety and sign-off: each medicine's generic and allergy class (the checks match brand, generic and class);
-- when the prescription was signed, and the amendments made after signing (each with a reason).
ALTER TABLE "medicine" ADD COLUMN "generic" text;--> statement-breakpoint
ALTER TABLE "medicine" ADD COLUMN "allergy_class" text;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "amendments" jsonb DEFAULT '[]'::jsonb NOT NULL;

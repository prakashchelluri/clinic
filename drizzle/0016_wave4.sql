ALTER TABLE "payment" ADD COLUMN "lender" text;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "fee_paise" integer;

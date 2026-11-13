-- The doctor's own price for a procedure plan: the total for all sittings. Empty means the clinic's standard price.
ALTER TABLE "recommendation" ADD COLUMN IF NOT EXISTS "amount_paise" integer;

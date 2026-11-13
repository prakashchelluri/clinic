-- A medicine line can run "Stat", "To be continued" or "Till required" instead of a number of days.
ALTER TABLE "prescription_item" ADD COLUMN IF NOT EXISTS "duration_note" text;

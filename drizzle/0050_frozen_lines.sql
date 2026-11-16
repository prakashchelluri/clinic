-- Lines keep the order they were entered in: what prints, and where a payment goes, follow it.
ALTER TABLE "charge" ADD COLUMN IF NOT EXISTS "line_no" integer;--> statement-breakpoint
UPDATE "charge" c SET "line_no" = x.n FROM (SELECT "id", row_number() OVER (PARTITION BY "bill_id" ORDER BY "created_at", "id") AS n FROM "charge") x WHERE x."id" = c."id" AND c."line_no" IS NULL;--> statement-breakpoint
-- runs after charge_bill (triggers fire in name order), so the line knows its invoice
CREATE OR REPLACE FUNCTION charge_line_no() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.line_no IS NULL THEN
    SELECT coalesce(max(line_no), 0) + 1 INTO NEW.line_no FROM charge WHERE bill_id = NEW.bill_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_line_no ON "charge";--> statement-breakpoint
CREATE TRIGGER charge_line_no BEFORE INSERT ON "charge" FOR EACH ROW EXECUTE FUNCTION charge_line_no();--> statement-breakpoint
-- A treatment line says how many sessions it bills; a credit note line how many sessions (and how much of the list price) it takes back.
ALTER TABLE "charge" ADD COLUMN IF NOT EXISTS "sessions" integer;--> statement-breakpoint
UPDATE "charge" SET "sessions" = 1 WHERE "session_id" IS NOT NULL AND "sessions" IS NULL;--> statement-breakpoint
UPDATE "charge" c SET "sessions" = co."sittings" FROM "course" co
  WHERE c."course_id" = co."id" AND c."session_id" IS NULL AND c."sessions" IS NULL
    AND (SELECT count(*) FROM "charge" x WHERE x."course_id" = co."id" AND x."session_id" IS NULL) = 1;--> statement-breakpoint
UPDATE "charge" c SET "sessions" = greatest(1, round((c."amount_paise" + c."discount_paise")::numeric / nullif(coalesce(co."standard_paise", co."list_paise") / greatest(co."sittings", 1), 0)))::int
  FROM "course" co WHERE c."course_id" = co."id" AND c."session_id" IS NULL AND c."sessions" IS NULL;--> statement-breakpoint
ALTER TABLE "credit_line" ADD COLUMN IF NOT EXISTS "sessions" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "credit_line" ADD COLUMN IF NOT EXISTS "list_paise" integer NOT NULL DEFAULT 0;--> statement-breakpoint
-- the refund voucher that paid a credit note out, when one did (its print says so)
ALTER TABLE "credit_note" ADD COLUMN IF NOT EXISTS "refund_no" text;--> statement-breakpoint
-- An issued invoice line never changes: what comes off it is a credit note. The database refuses anything else.
CREATE OR REPLACE FUNCTION charge_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_paise IS DISTINCT FROM OLD.amount_paise OR NEW.discount_paise IS DISTINCT FROM OLD.discount_paise
     OR NEW.tax_rate_bp IS DISTINCT FROM OLD.tax_rate_bp OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.bill_id IS DISTINCT FROM OLD.bill_id OR NEW.line_no IS DISTINCT FROM OLD.line_no
     OR (OLD.sessions IS NOT NULL AND NEW.sessions IS DISTINCT FROM OLD.sessions) THEN
    RAISE EXCEPTION 'ISSUED_INVOICE_LINE_IS_FROZEN: %', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_frozen ON "charge";--> statement-breakpoint
CREATE TRIGGER charge_frozen BEFORE UPDATE ON "charge" FOR EACH ROW EXECUTE FUNCTION charge_frozen();

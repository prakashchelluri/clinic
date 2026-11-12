-- Invoices: one numbered bill holds one or more lines (charges). Every charge belongs to a bill.
-- A charge inserted without a bill gets its own new bill with the next invoice number (a trigger, so no insert path is missed).
-- Pharmacy bills keep the pharmacy sale's own invoice number. Refunds of a bill are payment rows with bill_id set (no charge),
-- so what is due on the lines never grows back.
CREATE TABLE IF NOT EXISTS "bill" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "patient"("id"),
  "invoice_no" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bill_no" ON "bill" ("tenant_id","invoice_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bill_patient" ON "bill" ("tenant_id","patient_id");--> statement-breakpoint
ALTER TABLE "charge" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
-- the charges already there: one bill each, numbered in the order they were made (pharmacy keeps its number)
INSERT INTO "bill" ("id", "tenant_id", "created_at", "patient_id", "invoice_no")
  SELECT c."id", c."tenant_id", c."created_at", c."patient_id", s."invoice_no" FROM "charge" c JOIN "pharmacy_sale" s ON s."charge_id" = c."id";--> statement-breakpoint
INSERT INTO "bill" ("id", "tenant_id", "created_at", "patient_id", "invoice_no")
  SELECT x."id", x."tenant_id", x."created_at", x."patient_id", 'INV-' || lpad(x.n::text, 4, '0') FROM (
    SELECT c."id", c."tenant_id", c."created_at", c."patient_id", row_number() OVER (PARTITION BY c."tenant_id" ORDER BY c."created_at", c."id") AS n
    FROM "charge" c WHERE NOT EXISTS (SELECT 1 FROM "pharmacy_sale" s WHERE s."charge_id" = c."id")) x;--> statement-breakpoint
UPDATE "charge" SET "bill_id" = "id";--> statement-breakpoint
INSERT INTO "numbering_sequence" ("tenant_id", "key", "scope", "next_value")
  SELECT c."tenant_id", 'invoice_no', 'tenant', count(*) + 1 FROM "charge" c WHERE NOT EXISTS (SELECT 1 FROM "pharmacy_sale" s WHERE s."charge_id" = c."id") GROUP BY c."tenant_id"
  ON CONFLICT ("tenant_id", "key", "scope") DO UPDATE SET "next_value" = EXCLUDED."next_value";--> statement-breakpoint
CREATE OR REPLACE FUNCTION charge_bill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF NEW.bill_id IS NULL THEN
    INSERT INTO numbering_sequence (tenant_id, key, scope, next_value) VALUES (NEW.tenant_id, 'invoice_no', 'tenant', 2)
      ON CONFLICT (tenant_id, key, scope) DO UPDATE SET next_value = numbering_sequence.next_value + 1
      RETURNING next_value - 1 INTO n;
    NEW.bill_id := gen_random_uuid();
    INSERT INTO bill (id, tenant_id, patient_id, invoice_no) VALUES (NEW.bill_id, NEW.tenant_id, NEW.patient_id, 'INV-' || lpad(n::text, 4, '0'));
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_bill ON "charge";--> statement-breakpoint
CREATE TRIGGER charge_bill BEFORE INSERT ON "charge" FOR EACH ROW EXECUTE FUNCTION charge_bill();

-- Issued invoices never change. What comes off one is a numbered credit note against it; money paid above what is then owed moves to the advance.
CREATE TABLE IF NOT EXISTS "credit_note" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "patient"("id"),
  "bill_id" uuid NOT NULL,
  "credit_no" text NOT NULL,
  "reason" text NOT NULL,
  "total_paise" integer NOT NULL,
  "created_by" uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_no" ON "credit_note" ("tenant_id","credit_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_bill" ON "credit_note" ("tenant_id","bill_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_line" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "credit_note_id" uuid NOT NULL REFERENCES "credit_note"("id"),
  "charge_id" uuid NOT NULL REFERENCES "charge"("id"),
  "amount_paise" integer NOT NULL,
  "what" text NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_line_charge" ON "credit_line" ("charge_id");--> statement-breakpoint
-- an invoice prints as it was issued: the GSTIN in force then (for invoices already there, the clinic's GSTIN now is the best known)
ALTER TABLE "bill" ADD COLUMN IF NOT EXISTS "tax_gstin" text;--> statement-breakpoint
UPDATE "bill" b SET "tax_gstin" = nullif(t."settings"->>'gstin', '') FROM "tenant" t WHERE t."id" = b."tenant_id" AND b."tax_gstin" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION charge_bill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF NEW.bill_id IS NULL THEN
    INSERT INTO numbering_sequence (tenant_id, key, scope, next_value) VALUES (NEW.tenant_id, 'invoice_no', 'tenant', 2)
      ON CONFLICT (tenant_id, key, scope) DO UPDATE SET next_value = numbering_sequence.next_value + 1
      RETURNING next_value - 1 INTO n;
    NEW.bill_id := gen_random_uuid();
    INSERT INTO bill (id, tenant_id, patient_id, invoice_no, tax_gstin) VALUES (NEW.bill_id, NEW.tenant_id, NEW.patient_id, 'INV-' || lpad(n::text, 4, '0'),
      (SELECT nullif(settings->>'gstin', '') FROM tenant WHERE id = NEW.tenant_id));
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- lines an earlier build lowered in place (original_paise kept): back to their issued amount, with the difference as a credit note
INSERT INTO "credit_note" ("id", "tenant_id", "created_at", "patient_id", "bill_id", "credit_no", "reason", "total_paise")
  SELECT c."id", c."tenant_id", now(), c."patient_id", c."bill_id", 'CN-OLD-' || left(c."id"::text, 8), coalesce(c."adjustment_reason", 'Earlier change'),
    c."original_paise" - c."discount_paise" - c."amount_paise"
  FROM "charge" c WHERE c."original_paise" IS NOT NULL AND c."original_paise" - c."discount_paise" - c."amount_paise" > 0;--> statement-breakpoint
INSERT INTO "credit_line" ("tenant_id", "credit_note_id", "charge_id", "amount_paise", "what")
  SELECT c."tenant_id", c."id", c."id", c."original_paise" - c."discount_paise" - c."amount_paise", c."description"
  FROM "charge" c WHERE c."original_paise" IS NOT NULL AND c."original_paise" - c."discount_paise" - c."amount_paise" > 0;--> statement-breakpoint
UPDATE "charge" SET "amount_paise" = "original_paise" - "discount_paise" WHERE "original_paise" IS NOT NULL AND "original_paise" - "discount_paise" > "amount_paise";
--> statement-breakpoint
-- older refunds of a whole invoice (no line): money went back for something not given. Now: a credit note on the invoice's first line,
-- the same money taken off the line into the advance, and the refund paid out of the advance. What is due does not change.
INSERT INTO "credit_note" ("id", "tenant_id", "created_at", "patient_id", "bill_id", "credit_no", "reason", "total_paise")
  SELECT p."id", p."tenant_id", p."received_at", p."patient_id", p."bill_id", 'CN-OLD-' || left(p."id"::text, 8), coalesce(p."reference", 'Refund'), -p."amount_paise"
  FROM "payment" p WHERE p."bill_id" IS NOT NULL AND p."charge_id" IS NULL AND p."amount_paise" < 0 AND p."advance" = false AND p."method" <> 'advance'
    AND EXISTS (SELECT 1 FROM "charge" c WHERE c."bill_id" = p."bill_id" AND c."status" NOT IN ('cancelled', 'waived'));--> statement-breakpoint
INSERT INTO "credit_line" ("tenant_id", "credit_note_id", "charge_id", "amount_paise", "what")
  SELECT cn."tenant_id", cn."id", l."id", cn."total_paise", l."description" FROM "credit_note" cn
  JOIN LATERAL (SELECT c."id", c."description" FROM "charge" c WHERE c."bill_id" = cn."bill_id" AND c."status" NOT IN ('cancelled', 'waived') ORDER BY c."created_at", c."id" LIMIT 1) l ON true
  WHERE cn."credit_no" LIKE 'CN-OLD-%' AND NOT EXISTS (SELECT 1 FROM "credit_line" x WHERE x."credit_note_id" = cn."id");--> statement-breakpoint
INSERT INTO "payment" ("tenant_id", "patient_id", "charge_id", "amount_paise", "method", "reference", "received_by", "received_at", "advance")
  SELECT p."tenant_id", p."patient_id", cl."charge_id", p."amount_paise", 'advance', 'Moved to the advance for a refund', p."received_by", p."received_at", false
  FROM "payment" p JOIN "credit_line" cl ON cl."credit_note_id" = p."id" WHERE p."bill_id" IS NOT NULL AND p."charge_id" IS NULL AND p."amount_paise" < 0 AND p."advance" = false AND p."method" <> 'advance';--> statement-breakpoint
INSERT INTO "payment" ("tenant_id", "patient_id", "amount_paise", "method", "reference", "received_by", "received_at", "advance")
  SELECT p."tenant_id", p."patient_id", -p."amount_paise", 'advance', 'For a refund', p."received_by", p."received_at", true
  FROM "payment" p JOIN "credit_line" cl ON cl."credit_note_id" = p."id" WHERE p."bill_id" IS NOT NULL AND p."charge_id" IS NULL AND p."amount_paise" < 0 AND p."advance" = false AND p."method" <> 'advance';--> statement-breakpoint
UPDATE "payment" p SET "advance" = true FROM "credit_line" cl WHERE cl."credit_note_id" = p."id" AND p."bill_id" IS NOT NULL AND p."charge_id" IS NULL AND p."amount_paise" < 0 AND p."advance" = false;--> statement-breakpoint
-- older refunds on a line (money back, the line marked refunded): the same, on that line. A line an earlier build lowered already has its credit above.
INSERT INTO "credit_note" ("id", "tenant_id", "created_at", "patient_id", "bill_id", "credit_no", "reason", "total_paise")
  SELECT p."id", p."tenant_id", p."received_at", p."patient_id", c."bill_id", 'CN-OLD-' || left(p."id"::text, 8), coalesce(p."reference", 'Refund'), -p."amount_paise"
  FROM "payment" p JOIN "charge" c ON c."id" = p."charge_id"
  WHERE p."amount_paise" < 0 AND p."advance" = false AND p."method" <> 'advance' AND c."original_paise" IS NULL AND c."bill_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "credit_line" ("tenant_id", "credit_note_id", "charge_id", "amount_paise", "what")
  SELECT p."tenant_id", p."id", p."charge_id", -p."amount_paise", c."description" FROM "payment" p JOIN "charge" c ON c."id" = p."charge_id" JOIN "credit_note" cn ON cn."id" = p."id"
  WHERE p."amount_paise" < 0 AND p."advance" = false AND p."method" <> 'advance';--> statement-breakpoint
INSERT INTO "payment" ("tenant_id", "patient_id", "charge_id", "amount_paise", "method", "reference", "received_by", "received_at", "advance")
  SELECT p."tenant_id", p."patient_id", p."charge_id", p."amount_paise", 'advance', 'Moved to the advance for a refund', p."received_by", p."received_at", false
  FROM "payment" p WHERE p."charge_id" IS NOT NULL AND p."amount_paise" < 0 AND p."advance" = false AND p."method" <> 'advance'
    AND NOT EXISTS (SELECT 1 FROM "pharmacy_sale" s WHERE s."charge_id" = p."charge_id");--> statement-breakpoint
INSERT INTO "payment" ("tenant_id", "patient_id", "amount_paise", "method", "reference", "received_by", "received_at", "advance")
  SELECT p."tenant_id", p."patient_id", -p."amount_paise", 'advance', 'For a refund', p."received_by", p."received_at", true
  FROM "payment" p WHERE p."charge_id" IS NOT NULL AND p."amount_paise" < 0 AND p."advance" = false AND p."method" <> 'advance'
    AND NOT EXISTS (SELECT 1 FROM "pharmacy_sale" s WHERE s."charge_id" = p."charge_id");--> statement-breakpoint
UPDATE "payment" p SET "advance" = true, "bill_id" = c."bill_id", "charge_id" = NULL FROM "charge" c
  WHERE c."id" = p."charge_id" AND p."amount_paise" < 0 AND p."advance" = false AND p."method" <> 'advance'
    AND NOT EXISTS (SELECT 1 FROM "pharmacy_sale" s WHERE s."charge_id" = p."charge_id");--> statement-breakpoint
UPDATE "charge" SET "status" = 'paid' WHERE "status" = 'refunded';

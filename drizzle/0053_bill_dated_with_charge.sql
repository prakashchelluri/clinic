-- The invoice is dated when its first line was charged, not when the row was written: the same thing in daily use,
-- but a line entered with an earlier time (sample history, an import) no longer makes an old invoice look like today's.
CREATE OR REPLACE FUNCTION charge_bill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF NEW.bill_id IS NULL AND NEW.amount_paise > 0 THEN
    INSERT INTO numbering_sequence (tenant_id, key, scope, next_value) VALUES (NEW.tenant_id, 'invoice_no', 'tenant', 2)
      ON CONFLICT (tenant_id, key, scope) DO UPDATE SET next_value = numbering_sequence.next_value + 1
      RETURNING next_value - 1 INTO n;
    NEW.bill_id := gen_random_uuid();
    INSERT INTO bill (id, tenant_id, patient_id, invoice_no, tax_gstin, created_at) VALUES (NEW.bill_id, NEW.tenant_id, NEW.patient_id, 'INV-' || lpad(n::text, greatest(4, length(n::text)), '0'),
      (SELECT nullif(settings->>'gstin', '') FROM tenant WHERE id = NEW.tenant_id), coalesce(NEW.created_at, now()));
  END IF;
  RETURN NEW;
END $$;

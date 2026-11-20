-- lpad(n, 4) cut invoice 10000 down to "1000", which already exists, so every new charge after the 9,999th invoice failed.
-- Keep at least four digits and never fewer than the number has.
CREATE OR REPLACE FUNCTION charge_bill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF NEW.bill_id IS NULL AND NEW.amount_paise > 0 THEN
    INSERT INTO numbering_sequence (tenant_id, key, scope, next_value) VALUES (NEW.tenant_id, 'invoice_no', 'tenant', 2)
      ON CONFLICT (tenant_id, key, scope) DO UPDATE SET next_value = numbering_sequence.next_value + 1
      RETURNING next_value - 1 INTO n;
    NEW.bill_id := gen_random_uuid();
    INSERT INTO bill (id, tenant_id, patient_id, invoice_no, tax_gstin) VALUES (NEW.bill_id, NEW.tenant_id, NEW.patient_id, 'INV-' || lpad(n::text, greatest(4, length(n::text)), '0'),
      (SELECT nullif(settings->>'gstin', '') FROM tenant WHERE id = NEW.tenant_id));
  END IF;
  RETURN NEW;
END $$;

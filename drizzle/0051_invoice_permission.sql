-- Invoices and patient accounts get their own permission (fees.invoices). Doctors keep seeing prices (fees.see) but not invoices.
-- A clinic that saved its own roles: every role that sees fees gets the new permission, except doctor, assistant and pharmacist.
UPDATE "tenant" t SET "settings" = jsonb_set(t."settings", '{roles}', (
  SELECT jsonb_object_agg(r.key, CASE
    WHEN r.key NOT IN ('doctor', 'assistant', 'pharmacist') AND jsonb_typeof(r.value) = 'array' AND r.value ? 'fees.see' AND NOT r.value ? 'fees.invoices'
      THEN r.value || '["fees.invoices"]'::jsonb
    ELSE r.value END)
  FROM jsonb_each(t."settings"->'roles') r))
WHERE jsonb_typeof(t."settings"->'roles') = 'object' AND t."settings"->'roles' <> '{}'::jsonb;
--> statement-breakpoint
-- A free (₹0) line, such as a free consultation, is not an invoice: it gets no invoice number. The line stays, so reports count the visit.
CREATE OR REPLACE FUNCTION charge_bill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  IF NEW.bill_id IS NULL AND NEW.amount_paise > 0 THEN
    INSERT INTO numbering_sequence (tenant_id, key, scope, next_value) VALUES (NEW.tenant_id, 'invoice_no', 'tenant', 2)
      ON CONFLICT (tenant_id, key, scope) DO UPDATE SET next_value = numbering_sequence.next_value + 1
      RETURNING next_value - 1 INTO n;
    NEW.bill_id := gen_random_uuid();
    INSERT INTO bill (id, tenant_id, patient_id, invoice_no, tax_gstin) VALUES (NEW.bill_id, NEW.tenant_id, NEW.patient_id, 'INV-' || lpad(n::text, 4, '0'),
      (SELECT nullif(settings->>'gstin', '') FROM tenant WHERE id = NEW.tenant_id));
  END IF;
  RETURN NEW;
END $$;

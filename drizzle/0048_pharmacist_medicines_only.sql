-- The pharmacy login handles medicines only: no clinic billing page, no patient payments. A clinic that saved its own Pharmacy role loses the two as well.
UPDATE "tenant" SET "settings" = jsonb_set("settings", '{roles,pharmacist}',
  coalesce((SELECT jsonb_agg(p) FROM jsonb_array_elements("settings"->'roles'->'pharmacist') p WHERE p #>> '{}' NOT IN ('fees.see', 'payment.record')), '[]'::jsonb))
WHERE jsonb_typeof("settings"->'roles'->'pharmacist') = 'array';

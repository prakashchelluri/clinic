-- Pharmacy guards: a counter bill carries a key so a retry returns the same sale; a walk-in with no record keeps an optional name and phone on the sale only.
ALTER TABLE "pharmacy_sale" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD COLUMN "buyer_name" text;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD COLUMN "buyer_phone" text;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_sale_idem" ON "pharmacy_sale" USING btree ("tenant_id","idempotency_key");

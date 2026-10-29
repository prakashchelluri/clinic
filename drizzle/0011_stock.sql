ALTER TABLE "medicine" ADD COLUMN "pack_size" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "medicine" ADD COLUMN "reorder_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "medicine" SET "pack_size" = 10 WHERE "form" IN ('tab', 'cap');--> statement-breakpoint
UPDATE "medicine" SET "reorder_level" = 5;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "issued_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD COLUMN "not_issued_reason" text;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD COLUMN "payments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD COLUMN "returns" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "pharmacy_sale" SET "payments" = jsonb_build_array(jsonb_build_object('method', "method", 'amountPaise', "total_paise", 'reference', "reference"));--> statement-breakpoint
CREATE TABLE "vendor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"gstin" text,
	"address" text,
	"note" text,
	"active" boolean DEFAULT true NOT NULL
);--> statement-breakpoint
CREATE TABLE "stock_doc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"doc_no" text NOT NULL,
	"vendor_id" uuid REFERENCES "public"."vendor"("id"),
	"order_id" uuid,
	"status" text NOT NULL,
	"bill_no" text,
	"bill_date" date,
	"bill_total_paise" integer,
	"bill_photo_key" text,
	"due_date" date,
	"vendor_ref" text,
	"note" text,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" jsonb,
	"created_by" uuid NOT NULL,
	"created_by_name" text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "stock_doc_no" ON "stock_doc" USING btree ("tenant_id","kind","doc_no");--> statement-breakpoint
CREATE INDEX "stock_doc_at" ON "stock_doc" USING btree ("tenant_id","kind","created_at");--> statement-breakpoint
CREATE TABLE "stock_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"medicine_id" uuid NOT NULL REFERENCES "public"."medicine"("id"),
	"batch_no" text NOT NULL,
	"expiry" date NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"paid_qty" integer DEFAULT 0 NOT NULL,
	"free_qty" integer DEFAULT 0 NOT NULL,
	"cost_paise" integer DEFAULT 0 NOT NULL,
	"mrp_paise" integer DEFAULT 0 NOT NULL,
	"vendor_id" uuid,
	"receipt_id" uuid,
	"receipt_no" text,
	CONSTRAINT "stock_batch_qty_nonneg" CHECK ("qty" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "stock_batch_no" ON "stock_batch" USING btree ("tenant_id","medicine_id","batch_no");--> statement-breakpoint
CREATE INDEX "stock_batch_med" ON "stock_batch" USING btree ("tenant_id","medicine_id");--> statement-breakpoint
CREATE TABLE "stock_move" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch_id" uuid NOT NULL REFERENCES "public"."stock_batch"("id"),
	"medicine_id" uuid NOT NULL,
	"change" integer NOT NULL,
	"balance" integer NOT NULL,
	"kind" text NOT NULL,
	"doc_id" uuid,
	"doc_no" text,
	"note" text,
	"by" uuid NOT NULL,
	"by_name" text NOT NULL
);--> statement-breakpoint
CREATE INDEX "stock_move_med" ON "stock_move" USING btree ("tenant_id","medicine_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_move_batch" ON "stock_move" USING btree ("tenant_id","batch_id");--> statement-breakpoint
CREATE TABLE "vendor_owed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vendor_id" uuid NOT NULL REFERENCES "public"."vendor"("id"),
	"medicine_id" uuid NOT NULL,
	"name" text NOT NULL,
	"qty" integer NOT NULL,
	"from_doc_id" uuid NOT NULL,
	"from_doc_no" text NOT NULL,
	"status" text DEFAULT 'owed' NOT NULL,
	"settled_note" text,
	"decided_by" text NOT NULL
);--> statement-breakpoint
CREATE INDEX "vendor_owed_v" ON "vendor_owed" USING btree ("tenant_id","vendor_id","status");

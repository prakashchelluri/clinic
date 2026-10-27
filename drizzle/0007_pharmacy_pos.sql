CREATE TABLE "pharmacy_sale" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoice_no" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"charge_id" uuid,
	"items" jsonb NOT NULL,
	"gross_paise" integer NOT NULL,
	"discount_paise" integer DEFAULT 0 NOT NULL,
	"gst_paise" integer NOT NULL,
	"total_paise" integer NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"received_paise" integer,
	"created_by" uuid NOT NULL
);--> statement-breakpoint
ALTER TABLE "medicine" ADD COLUMN "mrp_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "medicine" ADD COLUMN "gst_bp" integer DEFAULT 1200 NOT NULL;--> statement-breakpoint
ALTER TABLE "medicine" ADD COLUMN "hsn" text;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD CONSTRAINT "pharmacy_sale_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD CONSTRAINT "pharmacy_sale_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_sale" ADD CONSTRAINT "pharmacy_sale_charge_id_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pharmacy_invoice" ON "pharmacy_sale" USING btree ("tenant_id","invoice_no");--> statement-breakpoint
CREATE INDEX "pharmacy_sale_at" ON "pharmacy_sale" USING btree ("tenant_id","created_at");--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 21000, "gst_bp" = 1200 WHERE "name" = 'Adapalene 0.1% gel' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 14500, "gst_bp" = 1200 WHERE "name" = 'Clindamycin 1% gel' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 9500, "gst_bp" = 1200 WHERE "name" = 'Doxycycline 100 mg' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 32000, "gst_bp" = 1200 WHERE "name" = 'Isotretinoin 20 mg' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 3000, "gst_bp" = 1200 WHERE "name" = 'Cetirizine 10 mg' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 11000, "gst_bp" = 1200 WHERE "name" = 'Mometasone 0.1% cream' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 12500, "gst_bp" = 1200 WHERE "name" = 'Ketoconazole 2% cream' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 16500, "gst_bp" = 1200 WHERE "name" = 'Terbinafine 250 mg' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 45000, "gst_bp" = 1800 WHERE "name" = 'Sunscreen SPF 50' AND "mrp_paise" = 0;--> statement-breakpoint
UPDATE "medicine" SET "mrp_paise" = 38000, "gst_bp" = 1800 WHERE "name" = 'Moisturiser (ceramide)' AND "mrp_paise" = 0;

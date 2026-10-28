CREATE TABLE "broadcast" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text NOT NULL,
	"audience_label" text NOT NULL,
	"recipients" integer NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"mode" text DEFAULT 'demo' NOT NULL,
	"created_by" uuid NOT NULL
);--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_at" ON "broadcast" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "broadcast_id" uuid;

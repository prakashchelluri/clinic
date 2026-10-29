CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"tenant_id" uuid NOT NULL REFERENCES "public"."tenant"("id"),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"user_name" text,
	"role" text,
	"ip" text,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"summary" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"patient_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"unusual" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
CREATE INDEX "audit_t_at" ON "audit_log" ("tenant_id", "at");--> statement-breakpoint
CREATE INDEX "audit_t_patient" ON "audit_log" ("tenant_id", "patient_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' AND coalesce(current_setting('app.audit_purge', true), '') = 'on' THEN RETURN OLD; END IF;
	RAISE EXCEPTION 'audit log rows cannot be changed or deleted';
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_log_no_edit BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

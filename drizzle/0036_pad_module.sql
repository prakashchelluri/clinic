-- Custom modules on the Rx pad (as Tatva has them): a name and 1-4 columns; on_pad = the users who keep it on their pad; used = locked.
CREATE TABLE IF NOT EXISTS "pad_module" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "name" text NOT NULL,
  "columns" text[] NOT NULL,
  "created_by" uuid,
  "on_pad" uuid[] DEFAULT '{}' NOT NULL,
  "used" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pad_module_t" ON "pad_module" ("tenant_id");

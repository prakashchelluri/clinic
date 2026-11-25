-- WhatsApp conversations: one chat per phone, its lines in and out. Numbered 0056: 0055 is taken on redesign/ux-audit.
CREATE TABLE IF NOT EXISTS "chat" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "phone" text NOT NULL,
  "status" text DEFAULT 'assistant' NOT NULL,
  "reason" text,
  "last_at" timestamp with time zone DEFAULT now() NOT NULL,
  "unread" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_phone" ON "chat" ("tenant_id", "phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_last" ON "chat" ("tenant_id", "last_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_message" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "chat_id" uuid NOT NULL REFERENCES "chat"("id"),
  "direction" text NOT NULL,
  "by" text NOT NULL,
  "body" text NOT NULL,
  "provider_ref" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatmsg_chat" ON "chat_message" ("chat_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chatmsg_ref" ON "chat_message" ("tenant_id", "provider_ref");

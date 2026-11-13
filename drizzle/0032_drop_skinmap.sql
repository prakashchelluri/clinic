-- The skin map is gone (13 Nov 2026): photos no longer point at a pin, and the pins go.
ALTER TABLE "document" DROP COLUMN IF EXISTS "pin_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "body_pin" CASCADE;

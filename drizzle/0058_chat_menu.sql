-- Tap-to-book: where the patient is in the menu, and the buttons or list sent with a line.
ALTER TABLE "chat" ADD COLUMN IF NOT EXISTS "flow" jsonb;--> statement-breakpoint
ALTER TABLE "chat_message" ADD COLUMN IF NOT EXISTS "options" jsonb;

-- Patient preferences: no WhatsApp messages (reminders and messages to many skip them), preferred language, and the record a duplicate was merged into. Staff: a first password that must be changed.
ALTER TABLE "patient" ADD COLUMN "no_whatsapp" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;

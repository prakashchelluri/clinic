-- A package is a bundle of procedures at one price. The pad keeps which package a plan came from; the course keeps its group and how long it is valid.
ALTER TABLE "recommendation" ADD COLUMN IF NOT EXISTS "package" jsonb;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "package_name" text;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "package_group" text;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN IF NOT EXISTS "valid_until" date;

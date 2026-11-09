-- Online requests are gone: an online booking is a booking. Requests still waiting become bookings.
UPDATE "appointment" SET "status" = 'booked' WHERE "status" = 'requested';--> statement-breakpoint
UPDATE "message" SET "status" = 'skipped' WHERE "kind" IN ('requested', 'declined') AND "status" = 'pending';

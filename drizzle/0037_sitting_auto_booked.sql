-- A sitting the system booked by itself when the one before was done (the plan's gap after it); cleared once someone moves it.
ALTER TABLE "procedure_session" ADD COLUMN IF NOT EXISTS "auto_booked" boolean DEFAULT false NOT NULL;

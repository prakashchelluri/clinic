-- A fingerprint (SHA-256) of every file as it was saved, so a signed consent page can be checked for changes later.
ALTER TABLE "document" ADD COLUMN IF NOT EXISTS "sha256" text;

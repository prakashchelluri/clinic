-- Money belongs to the patient, not to a procedure course. Sessions a course had paid for are now paid from the patient's advance,
-- and money taken "ahead" on a course becomes the patient's advance (what is left of it after those sessions).
-- 1) each session paid from a course: a payment on its invoice from the advance, and the matching use of the advance
INSERT INTO "payment" ("tenant_id", "patient_id", "charge_id", "amount_paise", "method", "reference", "received_by", "received_at", "advance")
SELECT c."tenant_id", c."patient_id", c."id", c."amount_paise", 'advance', 'Paid ahead on the course',
  coalesce((SELECT p."received_by" FROM "payment" p WHERE p."course_id" = c."course_id" LIMIT 1), c."adjusted_by", (SELECT u."id" FROM "app_user" u WHERE u."tenant_id" = c."tenant_id" LIMIT 1)),
  c."created_at", false
FROM "charge" c WHERE c."prepaid" = true AND c."status" NOT IN ('cancelled', 'waived') AND c."amount_paise" > 0;--> statement-breakpoint
INSERT INTO "payment" ("tenant_id", "patient_id", "amount_paise", "method", "reference", "received_by", "received_at", "advance")
SELECT c."tenant_id", c."patient_id", -c."amount_paise", 'advance', left(c."description", 60),
  coalesce((SELECT p."received_by" FROM "payment" p WHERE p."course_id" = c."course_id" LIMIT 1), c."adjusted_by", (SELECT u."id" FROM "app_user" u WHERE u."tenant_id" = c."tenant_id" LIMIT 1)),
  c."created_at", true
FROM "charge" c WHERE c."prepaid" = true AND c."status" NOT IN ('cancelled', 'waived') AND c."amount_paise" > 0;--> statement-breakpoint
-- ponytail: a session paid by an approved course discount (course.credit_paise) is counted as advance too; rare, can leave a small negative advance
UPDATE "charge" SET "prepaid" = false WHERE "prepaid" = true;--> statement-breakpoint
-- 2) money taken ahead on a course (and its refunds) is the patient's advance
UPDATE "payment" SET "advance" = true, "course_id" = NULL WHERE "course_id" IS NOT NULL AND "charge_id" IS NULL;--> statement-breakpoint
UPDATE "course" SET "credit_paise" = 0 WHERE "credit_paise" <> 0;

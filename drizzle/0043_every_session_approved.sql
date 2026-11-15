-- Every procedure session needs its doctor's approval. Sessions still to come that were marked approved without one
-- (booked with no doctor, or booked before approvals existed, by someone other than their own doctor) go back to Not sent,
-- so the coordinator sends them with the week. A session its own doctor booked, or that the doctor approved, stays approved.
UPDATE "procedure_session" ps SET "approval" = 'draft', "approved_by" = NULL, "approved_at" = NULL, "changed" = false
WHERE ps."state" = 'confirmed' AND ps."approval" = 'approved' AND ps."day" >= current_date
  AND NOT EXISTS (SELECT 1 FROM "app_user" u WHERE u."tenant_id" = ps."tenant_id" AND u."practitioner_id" IS NOT NULL
    AND u."practitioner_id" = ps."practitioner_id" AND (u."id" = ps."booked_by" OR u."name" = ps."approved_by"));

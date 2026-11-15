-- A doctor is required on every procedure session. Upcoming sessions booked with no doctor take their course's doctor
-- (the one named on the course, else the consultation's doctor), and that doctor's time is blocked as at booking.
-- They stay Not sent: the coordinator sends them for that doctor's approval with the week.
WITH given AS (
  UPDATE "procedure_session" ps SET "practitioner_id" = COALESCE(r."practitioner_id", e."practitioner_id"), "approval" = 'draft', "approved_by" = NULL, "approved_at" = NULL
  FROM "recommendation" r JOIN "encounter" e ON e."id" = r."encounter_id"
  WHERE r."id" = ps."recommendation_id" AND ps."practitioner_id" IS NULL AND ps."state" = 'confirmed' AND ps."day" >= current_date
    AND COALESCE(r."practitioner_id", e."practitioner_id") IS NOT NULL
  RETURNING ps."id", ps."tenant_id", ps."practitioner_id", ps."room_id", ps."day", ps."start_time", ps."end_time", ps."procedure_id", ps."sitting_no"
)
INSERT INTO "calendar_block" ("tenant_id", "practitioner_id", "room_id", "day", "start_time", "end_time", "kind", "note", "procedure_session_id")
SELECT g."tenant_id", g."practitioner_id", g."room_id", g."day", g."start_time", g."end_time", 'procedure', COALESCE(pc."name", 'Procedure') || ' · session ' || g."sitting_no", g."id"
FROM given g LEFT JOIN "procedure_catalog" pc ON pc."id" = g."procedure_id";

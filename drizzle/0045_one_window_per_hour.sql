-- Two screens opening a day at the same moment both filled it from the routine, so some doctors' hours were there twice,
-- and an hour with two windows offers no "+ Book". Keep one window per doctor and hour: the one with bookings, else the oldest.
-- Only routine windows with no bookings at all are removed.
DELETE FROM "session" s
WHERE s."source" = 'routine'
  AND NOT EXISTS (SELECT 1 FROM "appointment" a WHERE a."session_id" = s."id")
  AND EXISTS (
    SELECT 1 FROM "session" o
    WHERE o."tenant_id" = s."tenant_id" AND o."practitioner_id" IS NOT DISTINCT FROM s."practitioner_id" AND o."day" = s."day"
      AND o."start_time" = s."start_time" AND o."end_time" = s."end_time" AND o."id" <> s."id"
      AND (EXISTS (SELECT 1 FROM "appointment" a2 WHERE a2."session_id" = o."id") OR o."created_at" < s."created_at" OR (o."created_at" = s."created_at" AND o."id" < s."id")));

-- The default learner group should allow any time chosen and opened by an administrator.
-- Only upgrade the untouched 08:00-22:00 defaults; preserve administrator-customized rules.
WITH default_group AS (
  SELECT g."id"
  FROM "Group" g
  WHERE g."name" = '普通学员'
    AND (SELECT count(*) FROM "GroupScheduleRule" r WHERE r."groupId" = g."id") = 7
    AND NOT EXISTS (
      SELECT 1 FROM "GroupScheduleRule" r
      WHERE r."groupId" = g."id"
        AND (r."startMinute" <> 480 OR r."endMinute" <> 1320)
    )
), removed AS (
  DELETE FROM "GroupScheduleRule"
  WHERE "groupId" IN (SELECT "id" FROM default_group)
  RETURNING "groupId"
)
INSERT INTO "GroupScheduleRule" ("id", "groupId", "weekday", "startMinute", "endMinute")
SELECT 'default-learner-' || weekday, removed."groupId", weekday, 0, 1440
FROM (SELECT DISTINCT "groupId" FROM removed) removed
CROSS JOIN generate_series(0, 6) AS weekday;

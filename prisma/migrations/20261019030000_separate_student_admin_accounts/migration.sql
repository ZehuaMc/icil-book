-- Earlier admin registration upgraded a same-student USER row in place.
-- Restore a separate learner identity for those rows and keep their reservations.
-- The previous migration still has a global studentId unique index. Drop it
-- before inserting the learner copy, otherwise the copy itself violates the
-- old constraint. The temporary mapping survives for the whole migration
-- transaction and is removed explicitly at the end.
CREATE TEMP TABLE "LegacyLearnerAccounts" AS
SELECT "id" AS "adminId", 'legacy-learner-' || "id" AS "learnerId"
FROM "User"
WHERE "role" = 'ADMIN' AND "email" = "studentId" || '@student.local';

DROP INDEX IF EXISTS "User_studentId_key";

INSERT INTO "User" (
  "id", "name", "studentId", "email", "passwordHash", "role", "enabled",
  "groupId", "createdAt"
)
SELECT
  legacy."learnerId", account."name", account."studentId",
  account."studentId" || '+user@student.local', account."passwordHash",
  'USER', account."enabled", account."groupId", account."createdAt"
FROM "User" account
JOIN "LegacyLearnerAccounts" legacy ON legacy."adminId" = account."id";

UPDATE "Reservation" reservation
SET "userId" = legacy."learnerId"
FROM "LegacyLearnerAccounts" legacy
WHERE reservation."userId" = legacy."adminId";

CREATE UNIQUE INDEX "User_studentId_role_key" ON "User"("studentId", "role");
DROP TABLE "LegacyLearnerAccounts";

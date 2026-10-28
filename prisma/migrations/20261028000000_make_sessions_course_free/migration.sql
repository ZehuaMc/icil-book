-- Study-room sessions are independent of courses. Keep the legacy table and
-- values readable, but allow all new sessions to omit the old association.
ALTER TABLE "Session" ALTER COLUMN "courseId" DROP NOT NULL;

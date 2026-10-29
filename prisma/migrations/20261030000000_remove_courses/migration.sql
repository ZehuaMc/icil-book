-- Courses are no longer part of the teaching-station reservation model.
ALTER TABLE "Session" DROP CONSTRAINT IF EXISTS "Session_courseId_fkey";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "courseId";
DROP TABLE IF EXISTS "Course";

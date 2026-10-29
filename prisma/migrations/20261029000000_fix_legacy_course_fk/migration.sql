-- Legacy course links are optional. Deleting a retained legacy course should
-- leave the study-room session intact and clear its compatibility reference.
ALTER TABLE "Session" DROP CONSTRAINT IF EXISTS "Session_courseId_fkey";
ALTER TABLE "Session"
  ADD CONSTRAINT "Session_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

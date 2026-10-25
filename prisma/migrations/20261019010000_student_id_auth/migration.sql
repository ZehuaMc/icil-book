ALTER TABLE "User" ADD COLUMN "studentId" TEXT;

UPDATE "User"
SET "studentId" = CASE
  WHEN "email" = 'admin@station.local' THEN 'admin001'
  WHEN "email" = 'assistant@station.local' THEN 'assistant001'
  WHEN "email" = 'learner@station.local' THEN 'student001'
  ELSE 'legacy' || regexp_replace("id", '[^a-zA-Z0-9]', '', 'g')
END;

ALTER TABLE "User" ALTER COLUMN "studentId" SET NOT NULL;
CREATE UNIQUE INDEX "User_studentId_key" ON "User"("studentId");

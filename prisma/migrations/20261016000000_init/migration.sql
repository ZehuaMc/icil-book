CREATE TYPE "Role" AS ENUM ('USER', 'ASSISTANT', 'ADMIN');
CREATE TYPE "LayoutStatus" AS ENUM ('DRAFT', 'PUBLISHED');
CREATE TYPE "ElementKind" AS ENUM ('DESK', 'BOOTH', 'DIVIDER', 'LABEL');
CREATE TABLE "Group" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "canReserve" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "Group_name_key" ON "Group"("name");
CREATE TABLE "AppSetting" (
  "id" TEXT PRIMARY KEY DEFAULT 'main', "defaultGroupId" TEXT NOT NULL REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "GroupScheduleRule" (
  "id" TEXT PRIMARY KEY, "groupId" TEXT NOT NULL REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "weekday" INTEGER NOT NULL CHECK ("weekday" BETWEEN 0 AND 6),
  "startMinute" INTEGER NOT NULL CHECK ("startMinute" >= 0), "endMinute" INTEGER NOT NULL CHECK ("endMinute" <= 1440),
  CHECK ("startMinute" < "endMinute")
);
CREATE TABLE "GroupDateRule" (
  "id" TEXT PRIMARY KEY, "groupId" TEXT NOT NULL REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "date" TEXT NOT NULL, "allowed" BOOLEAN NOT NULL DEFAULT true,
  "startMinute" INTEGER NOT NULL DEFAULT 0 CHECK ("startMinute" >= 0), "endMinute" INTEGER NOT NULL DEFAULT 1440 CHECK ("endMinute" <= 1440),
  CHECK ("startMinute" < "endMinute")
);
CREATE INDEX "GroupDateRule_groupId_date_idx" ON "GroupDateRule"("groupId", "date");
CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'USER', "enabled" BOOLEAN NOT NULL DEFAULT true,
  "groupId" TEXT NOT NULL REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE TABLE "AuthSession" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE "Venue" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "location" TEXT NOT NULL);
CREATE TABLE "LayoutVersion" (
  "id" TEXT PRIMARY KEY, "venueId" TEXT NOT NULL REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "name" TEXT NOT NULL, "status" "LayoutStatus" NOT NULL DEFAULT 'DRAFT', "width" INTEGER NOT NULL DEFAULT 1000,
  "height" INTEGER NOT NULL DEFAULT 660, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMPTZ(3)
);
CREATE TABLE "LayoutElement" (
  "id" TEXT PRIMARY KEY, "layoutId" TEXT NOT NULL REFERENCES "LayoutVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" "ElementKind" NOT NULL, "label" TEXT NOT NULL, "x" DOUBLE PRECISION NOT NULL, "y" DOUBLE PRECISION NOT NULL,
  "width" DOUBLE PRECISION NOT NULL, "height" DOUBLE PRECISION NOT NULL, "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE "Seat" (
  "id" TEXT PRIMARY KEY, "layoutId" TEXT NOT NULL REFERENCES "LayoutVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "elementId" TEXT REFERENCES "LayoutElement"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "code" TEXT NOT NULL, "x" DOUBLE PRECISION NOT NULL, "y" DOUBLE PRECISION NOT NULL, "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "Seat_layoutId_code_key" ON "Seat"("layoutId", "code");
CREATE TABLE "Course" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT '', "instructor" TEXT NOT NULL);
CREATE TABLE "Session" (
  "id" TEXT PRIMARY KEY, "courseId" TEXT NOT NULL REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "layoutId" TEXT NOT NULL REFERENCES "LayoutVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "startsAt" TIMESTAMPTZ(3) NOT NULL, "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "requiredAssistants" INTEGER NOT NULL DEFAULT 1 CHECK ("requiredAssistants" >= 1), "open" BOOLEAN NOT NULL DEFAULT true,
  CHECK ("endsAt" > "startsAt")
);
CREATE INDEX "Session_startsAt_idx" ON "Session"("startsAt");
CREATE TABLE "AssistantCoverage" (
  "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "assistantId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AssistantCoverage_sessionId_assistantId_key" ON "AssistantCoverage"("sessionId", "assistantId");
CREATE TABLE "Reservation" (
  "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "seatId" TEXT NOT NULL REFERENCES "Seat"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "cancelledAt" TIMESTAMPTZ(3)
);
CREATE INDEX "Reservation_sessionId_seatId_idx" ON "Reservation"("sessionId", "seatId");
CREATE INDEX "Reservation_sessionId_userId_idx" ON "Reservation"("sessionId", "userId");
-- Cancellation keeps history while immediately releasing both uniqueness constraints.
CREATE UNIQUE INDEX "Reservation_active_seat_key" ON "Reservation"("sessionId", "seatId") WHERE "cancelledAt" IS NULL;
CREATE UNIQUE INDEX "Reservation_active_user_key" ON "Reservation"("sessionId", "userId") WHERE "cancelledAt" IS NULL;
CREATE TABLE "AuditLog" (
  "id" TEXT PRIMARY KEY, "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "action" TEXT NOT NULL, "target" TEXT NOT NULL, "details" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "LoginAttempt" ("key" TEXT PRIMARY KEY, "count" INTEGER NOT NULL DEFAULT 1, "resetAt" TIMESTAMPTZ(3) NOT NULL);

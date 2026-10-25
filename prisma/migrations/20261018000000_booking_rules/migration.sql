ALTER TABLE "Seat" ADD COLUMN "fixedForAssistant" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "SessionAdminBooking" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "adminId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SessionAdminBooking_sessionId_adminId_key" ON "SessionAdminBooking"("sessionId", "adminId");
CREATE INDEX "SessionAdminBooking_sessionId_idx" ON "SessionAdminBooking"("sessionId");

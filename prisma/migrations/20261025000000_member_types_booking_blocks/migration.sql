CREATE TYPE "MemberType" AS ENUM ('YSYX', 'ICIL');
ALTER TABLE "User" ADD COLUMN "memberType" "MemberType" NOT NULL DEFAULT 'YSYX';

CREATE TYPE "BookingBlockKind" AS ENUM ('SESSION', 'DAY');
CREATE TABLE "BookingBlock" (
  "id" TEXT NOT NULL,
  "kind" "BookingBlockKind" NOT NULL,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "sessionId" TEXT,
  "reason" TEXT NOT NULL DEFAULT '',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL,
  CONSTRAINT "BookingBlock_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingBlock_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookingBlock_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingBlock_time_check" CHECK ("endsAt" > "startsAt")
);
CREATE INDEX "BookingBlock_startsAt_endsAt_active_idx" ON "BookingBlock"("startsAt", "endsAt", "active");
CREATE INDEX "BookingBlock_sessionId_active_idx" ON "BookingBlock"("sessionId", "active");

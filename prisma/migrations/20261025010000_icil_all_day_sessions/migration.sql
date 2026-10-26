ALTER TABLE "Session" ADD COLUMN "icilOnly" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Session_icilOnly_idx" ON "Session"("icilOnly");

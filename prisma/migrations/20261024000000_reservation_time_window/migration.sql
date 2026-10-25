ALTER TABLE "Reservation" ADD COLUMN "startsAt" TIMESTAMPTZ(3);
ALTER TABLE "Reservation" ADD COLUMN "endsAt" TIMESTAMPTZ(3);

UPDATE "Reservation" AS reservation
SET "startsAt" = session."startsAt", "endsAt" = session."endsAt"
FROM "Session" AS session
WHERE reservation."sessionId" = session."id";

ALTER TABLE "Reservation" ALTER COLUMN "startsAt" SET NOT NULL;
ALTER TABLE "Reservation" ALTER COLUMN "endsAt" SET NOT NULL;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_time_window_check" CHECK ("endsAt" > "startsAt");
CREATE INDEX "Reservation_startsAt_idx" ON "Reservation"("startsAt");

DROP INDEX "Reservation_active_seat_key";
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "Reservation"
  ADD CONSTRAINT "Reservation_active_seat_time_excl"
  EXCLUDE USING gist (
    "sessionId" WITH =,
    "seatId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  ) WHERE ("cancelledAt" IS NULL);

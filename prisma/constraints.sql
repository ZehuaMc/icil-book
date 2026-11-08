-- Database guarantees that cannot be expressed in the Prisma model.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('GroupScheduleRule', 'GroupScheduleRule_weekday_check', 'CHECK ("weekday" BETWEEN 0 AND 6)'),
    ('GroupScheduleRule', 'GroupScheduleRule_time_check', 'CHECK ("startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute")'),
    ('GroupDateRule', 'GroupDateRule_time_check', 'CHECK ("startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute")'),
    ('Session', 'Session_time_check', 'CHECK ("endsAt" > "startsAt")'),
    ('Session', 'Session_requiredAssistants_check', 'CHECK ("requiredAssistants" >= 1)'),
    ('BookingBlock', 'BookingBlock_time_check', 'CHECK ("endsAt" > "startsAt")'),
    ('Reservation', 'Reservation_time_window_check', 'CHECK ("endsAt" > "startsAt")'),
    ('Reservation', 'Reservation_active_seat_time_excl', 'EXCLUDE USING gist ("sessionId" WITH =, "seatId" WITH =, tstzrange("startsAt", "endsAt", ''[)'') WITH &&) WHERE ("cancelledAt" IS NULL)'),
    ('Reservation', 'Reservation_active_user_time_excl', 'EXCLUDE USING gist ("sessionId" WITH =, "userId" WITH =, tstzrange("startsAt", "endsAt", ''[)'') WITH &&) WHERE ("cancelledAt" IS NULL)')
  ) AS definitions(table_name, constraint_name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('%I', item.table_name)::regclass
        AND conname = item.constraint_name
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.table_name, item.constraint_name, item.definition);
    END IF;
  END LOOP;
END $$;

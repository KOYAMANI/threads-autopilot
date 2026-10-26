-- Check slot rules only when a row takes a slot (enters an active status, or its time or slot flag changes).
-- The guard also ran on scheduled -> publishing, so a slot appointment with a custom-time post within
-- minGapMin could never be claimed and blocked every later post of the account (DECISIONS 2026-10-27).
DROP TRIGGER queue_slot_update_guard;
CREATE TRIGGER queue_slot_update_guard BEFORE UPDATE OF status, scheduled_at, slot_managed ON queue
WHEN NEW.scheduled_at IS NOT NULL AND NEW.status IN ('scheduled','pending_approval','publishing')
  AND NOT (OLD.status IN ('scheduled','pending_approval','publishing')
    AND OLD.scheduled_at IS NEW.scheduled_at AND OLD.slot_managed = NEW.slot_managed)
BEGIN
  SELECT RAISE(ABORT, 'POSTING_SLOT_OCCUPIED') WHERE EXISTS (
    SELECT 1 FROM posting_slot_reservations r WHERE r.account_id=NEW.account_id
      AND r.scheduled_at=NEW.scheduled_at AND (r.queue_id IS NULL OR r.queue_id<>NEW.id)
  );
  SELECT RAISE(ABORT, 'POSTING_SLOT_OCCUPIED') WHERE NEW.slot_managed=1 AND EXISTS (
    SELECT 1 FROM queue q WHERE q.account_id=NEW.account_id AND q.id<>NEW.id AND q.scheduled_at=NEW.scheduled_at
      AND q.status IN ('scheduled','pending_approval','publishing','done')
  );
  SELECT RAISE(ABORT, 'POSTING_SLOT_OCCUPIED') WHERE NEW.slot_managed=1 AND EXISTS (
    SELECT 1 FROM queue q WHERE q.account_id=NEW.account_id AND q.id<>NEW.id
      AND q.status IN ('scheduled','pending_approval','publishing','done') AND q.scheduled_at IS NOT NULL
      AND ABS(unixepoch(q.scheduled_at)-unixepoch(NEW.scheduled_at)) < 60 * COALESCE(
        (SELECT json_extract(settings_json, '$.minGapMin') FROM accounts WHERE id=NEW.account_id), 30)
  );
  SELECT RAISE(ABORT, 'AUTOPILOT_DAILY_LIMIT') WHERE NEW.slot_managed=1 AND NEW.source='autopilot' AND NOT EXISTS (
    SELECT 1 FROM posting_slot_reservations r WHERE r.account_id=NEW.account_id AND r.local_day=NEW.slot_day AND r.reservation_key=NEW.id
  ) AND (SELECT COUNT(DISTINCT reservation_key) FROM posting_slot_reservations r WHERE r.account_id=NEW.account_id
      AND r.source='autopilot' AND r.local_day=NEW.slot_day) >= 3;
END;

-- Account-owned schedules. Reservations survive cancellation/deletion so AP never refills a skipped slot.
CREATE TABLE posting_schedules (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  times_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE queue ADD COLUMN slot_managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queue ADD COLUMN slot_day TEXT;
ALTER TABLE queue ADD COLUMN request_id TEXT;
CREATE INDEX queue_account_scheduled_at ON queue(account_id, scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE UNIQUE INDEX queue_request_id ON queue(account_id, request_id) WHERE request_id IS NOT NULL;
CREATE TABLE posting_slot_reservations (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL,
  queue_id TEXT REFERENCES queue(id) ON DELETE SET NULL,
  reservation_key TEXT NOT NULL,
  source TEXT NOT NULL,
  local_day TEXT NOT NULL,
  PRIMARY KEY (account_id, scheduled_at)
);
CREATE INDEX posting_slot_day ON posting_slot_reservations(account_id, source, local_day);

-- Existing custom appointments remain untouched. Any new write must respect reserved slots.
CREATE TRIGGER queue_slot_insert_guard BEFORE INSERT ON queue
WHEN NEW.scheduled_at IS NOT NULL AND NEW.status IN ('scheduled','pending_approval','publishing')
BEGIN
  SELECT RAISE(ABORT, 'POSTING_SLOT_OCCUPIED') WHERE EXISTS (
    SELECT 1 FROM posting_slot_reservations r WHERE r.account_id=NEW.account_id
      AND r.scheduled_at=NEW.scheduled_at AND (r.queue_id IS NULL OR r.queue_id<>NEW.id)
  );
  SELECT RAISE(ABORT, 'POSTING_SLOT_OCCUPIED') WHERE NEW.slot_managed=1 AND EXISTS (
    SELECT 1 FROM queue q WHERE q.account_id=NEW.account_id AND q.scheduled_at=NEW.scheduled_at
      AND q.status IN ('scheduled','pending_approval','publishing','done')
  );
  SELECT RAISE(ABORT, 'POSTING_SLOT_OCCUPIED') WHERE NEW.slot_managed=1 AND EXISTS (
    SELECT 1 FROM queue q WHERE q.account_id=NEW.account_id AND q.id<>NEW.id
      AND q.status IN ('scheduled','pending_approval','publishing','done') AND q.scheduled_at IS NOT NULL
      AND ABS(unixepoch(q.scheduled_at)-unixepoch(NEW.scheduled_at)) < 60 * COALESCE(
        (SELECT json_extract(settings_json, '$.minGapMin') FROM accounts WHERE id=NEW.account_id), 30)
  );
  SELECT RAISE(ABORT, 'AUTOPILOT_DAILY_LIMIT') WHERE NEW.slot_managed=1 AND NEW.source='autopilot' AND (
    SELECT COUNT(DISTINCT reservation_key) FROM posting_slot_reservations r WHERE r.account_id=NEW.account_id
      AND r.source='autopilot' AND r.local_day=NEW.slot_day
  ) >= 3;
END;
CREATE TRIGGER queue_slot_insert_reserve AFTER INSERT ON queue
WHEN NEW.slot_managed=1 AND NEW.scheduled_at IS NOT NULL AND NEW.status IN ('scheduled','pending_approval','publishing')
BEGIN
  INSERT INTO posting_slot_reservations (account_id, scheduled_at, queue_id, reservation_key, source, local_day)
    VALUES (NEW.account_id, NEW.scheduled_at, NEW.id, NEW.id, NEW.source, NEW.slot_day);
END;
CREATE TRIGGER queue_slot_update_guard BEFORE UPDATE OF status, scheduled_at, slot_managed ON queue
WHEN NEW.scheduled_at IS NOT NULL AND NEW.status IN ('scheduled','pending_approval','publishing')
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
CREATE TRIGGER queue_slot_update_reserve AFTER UPDATE OF status, scheduled_at, slot_managed ON queue
WHEN NEW.slot_managed=1 AND NEW.scheduled_at IS NOT NULL AND NEW.status IN ('scheduled','pending_approval','publishing')
BEGIN
  INSERT INTO posting_slot_reservations (account_id, scheduled_at, queue_id, reservation_key, source, local_day)
    VALUES (NEW.account_id, NEW.scheduled_at, NEW.id, NEW.id, NEW.source, NEW.slot_day)
    ON CONFLICT(account_id, scheduled_at) DO NOTHING;
END;
-- Preserve existing opt-in and frequency choices, cap only previously larger safety limits.
UPDATE autopilot SET daily_limit=MIN(3, daily_limit), per_week=MIN(3, daily_limit)*7;

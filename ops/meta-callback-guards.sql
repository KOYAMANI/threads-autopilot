-- Additive privacy callback guards, compatible with app schemas 0005 and 0009.
-- Apply this file explicitly to EACH database. Do not apply unrelated app migrations.
-- Minimal replay/revocation metadata only; no tokens, profile fields or post content.
CREATE TABLE IF NOT EXISTS meta_subject_cutoffs (
  threads_user_id TEXT PRIMARY KEY,
  blocked_before TEXT NOT NULL,
  delete_before TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_meta_subject ON accounts(threads_user_id,token_obtained_at);

-- An authorization grant is distinct from a token's automatic refresh time.
-- Existing refreshed rows no longer contain the original grant time. Use their
-- creation time conservatively; see docs/meta-callbacks.md before rollout.
CREATE TABLE IF NOT EXISTS meta_account_grants (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL
);
INSERT INTO meta_account_grants(account_id,granted_at)
  SELECT id,CASE WHEN token_last_refresh_at IS NULL THEN token_obtained_at ELSE created_at END
  FROM accounts WHERE true ON CONFLICT(account_id) DO NOTHING;

-- The connect route explicitly clears token_last_refresh_at and sets status=ok.
-- Automatic refresh sets token_last_refresh_at and MUST NOT advance this grant.
CREATE TRIGGER IF NOT EXISTS meta_grant_insert AFTER INSERT ON accounts
BEGIN
  INSERT INTO meta_account_grants(account_id,granted_at) VALUES (NEW.id,NEW.token_obtained_at);
END;
CREATE TRIGGER IF NOT EXISTS meta_grant_reconnect AFTER UPDATE OF token_enc,token_obtained_at ON accounts
WHEN NEW.token_enc<>'' AND NEW.status='ok' AND NEW.token_last_refresh_at IS NULL
  AND (NEW.token_enc<>OLD.token_enc OR NEW.token_obtained_at<>OLD.token_obtained_at)
BEGIN
  INSERT INTO meta_account_grants(account_id,granted_at) VALUES (NEW.id,NEW.token_obtained_at)
    ON CONFLICT(account_id) DO UPDATE SET granted_at=excluded.granted_at;
END;

-- A delayed old connection must not recreate a deleted/revoked grant.
CREATE TRIGGER IF NOT EXISTS meta_account_insert_guard BEFORE INSERT ON accounts
WHEN NEW.token_enc<>'' AND EXISTS (
  SELECT 1 FROM meta_subject_cutoffs c WHERE c.threads_user_id=NEW.threads_user_id
    AND NEW.token_obtained_at<=c.blocked_before)
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_REVOKED'); END;
CREATE TRIGGER IF NOT EXISTS meta_account_update_guard BEFORE UPDATE OF token_enc,token_obtained_at,status ON accounts
WHEN NEW.token_enc<>'' AND (
  EXISTS (SELECT 1 FROM meta_subject_cutoffs c WHERE c.threads_user_id=NEW.threads_user_id
    AND (CASE WHEN NEW.status='ok' AND NEW.token_last_refresh_at IS NULL
      AND (NEW.token_enc<>OLD.token_enc OR NEW.token_obtained_at<>OLD.token_obtained_at)
      THEN NEW.token_obtained_at
      ELSE COALESCE((SELECT granted_at FROM meta_account_grants WHERE account_id=OLD.id),OLD.created_at)
      END)<=c.blocked_before)
  OR (OLD.token_enc='' AND OLD.status='needs_reauth'
    AND (NEW.status<>'ok' OR NEW.token_last_refresh_at IS NOT NULL))
  OR (NEW.token_enc<>OLD.token_enc AND NEW.token_obtained_at<OLD.token_obtained_at))
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_REVOKED'); END;

-- The old app has no FK on posts. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_posts_insert_guard BEFORE INSERT ON posts
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on posts. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_posts_update_guard BEFORE UPDATE ON posts
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on post_metrics_history. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_post_metrics_history_insert_guard BEFORE INSERT ON post_metrics_history
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on post_metrics_history. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_post_metrics_history_update_guard BEFORE UPDATE ON post_metrics_history
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on queue. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_queue_insert_guard BEFORE INSERT ON queue
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on queue. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_queue_update_guard BEFORE UPDATE ON queue
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on learning. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_learning_insert_guard BEFORE INSERT ON learning
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on learning. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_learning_update_guard BEFORE UPDATE ON learning
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on links. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_links_insert_guard BEFORE INSERT ON links
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on links. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_links_update_guard BEFORE UPDATE ON links
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on autopilot. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_autopilot_insert_guard BEFORE INSERT ON autopilot
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on autopilot. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_autopilot_update_guard BEFORE UPDATE ON autopilot
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on jobs. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_jobs_insert_guard BEFORE INSERT ON jobs
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on jobs. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_jobs_update_guard BEFORE UPDATE ON jobs
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on daily_views. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_daily_views_insert_guard BEFORE INSERT ON daily_views
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on daily_views. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_daily_views_update_guard BEFORE UPDATE ON daily_views
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on follower_snapshots. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_follower_snapshots_insert_guard BEFORE INSERT ON follower_snapshots
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on follower_snapshots. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_follower_snapshots_update_guard BEFORE UPDATE ON follower_snapshots
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on click_weeks. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_click_weeks_insert_guard BEFORE INSERT ON click_weeks
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on click_weeks. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_click_weeks_update_guard BEFORE UPDATE ON click_weeks
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on click_weeks_done. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_click_weeks_done_insert_guard BEFORE INSERT ON click_weeks_done
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on click_weeks_done. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_click_weeks_done_update_guard BEFORE UPDATE ON click_weeks_done
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on demographics. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_demographics_insert_guard BEFORE INSERT ON demographics
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on demographics. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_demographics_update_guard BEFORE UPDATE ON demographics
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on ap_log. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_ap_log_insert_guard BEFORE INSERT ON ap_log
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;
-- The old app has no FK on ap_log. Stop delayed jobs from restoring removed data.
CREATE TRIGGER IF NOT EXISTS meta_ap_log_update_guard BEFORE UPDATE ON ap_log
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts a WHERE a.id=NEW.account_id AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;

-- Account-specific audit writes may finish after a network request as well.
-- Login and other user-level audit records (without accountId) remain valid.
CREATE TRIGGER IF NOT EXISTS meta_audit_insert_guard BEFORE INSERT ON audit_log
WHEN CASE WHEN json_valid(NEW.detail) THEN json_type(NEW.detail,'$.accountId')='text' ELSE 0 END
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=json_extract(NEW.detail,'$.accountId') AND a.token_enc<>'')
BEGIN SELECT RAISE(ABORT,'META_ACCOUNT_UNAVAILABLE'); END;

-- Secrets remain encrypted in D1; no secret columns are exported to Sheets.
ALTER TABLE password_resets ADD COLUMN claim_id TEXT;
ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT;
CREATE INDEX idx_push_session ON push_subscriptions(session_id);
-- Old subscriptions cannot be attributed to a device session; require re-subscription.
DELETE FROM push_subscriptions;
UPDATE notifications SET push_enabled=0;
CREATE INDEX idx_sources_owner ON sources(user_id, created_at);
CREATE TABLE cron_sweeps (id TEXT PRIMARY KEY, kind TEXT NOT NULL, period TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0);
ALTER TABLE jobs ADD COLUMN dispatched_until TEXT;
CREATE INDEX idx_jobs_dispatch ON jobs(status, dispatched_until, next_run_at);
CREATE TABLE google_connections (
 user_id TEXT PRIMARY KEY, refresh_enc TEXT NOT NULL, spreadsheet_id TEXT,
 status TEXT NOT NULL DEFAULT 'connected', last_sync_at TEXT, last_error TEXT,
 next_sync_at TEXT NOT NULL, lease_id TEXT, lease_until TEXT,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_google_due ON google_connections(status, next_sync_at);
CREATE TABLE google_oauth_states (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
 browser_hash TEXT NOT NULL, verifier_enc TEXT NOT NULL, expires_at TEXT NOT NULL
);
ALTER TABLE google_connections ADD COLUMN google_sub TEXT NOT NULL DEFAULT '';
CREATE TABLE google_api_budget(bucket TEXT PRIMARY KEY,n INTEGER NOT NULL);

CREATE INDEX idx_jobs_active_account_type ON jobs(account_id,type,status);
CREATE INDEX idx_jobs_active_sheets_user ON jobs(type,json_extract(state_json,'$.userId'),status);

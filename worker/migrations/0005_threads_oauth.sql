CREATE TABLE threads_oauth_states (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 browser_hash TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE INDEX idx_threads_oauth_expiry ON threads_oauth_states(expires_at);

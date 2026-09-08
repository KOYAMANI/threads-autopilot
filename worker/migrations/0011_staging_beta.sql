-- Staging-only grants; no secrets are stored here.
CREATE TABLE staging_beta_licenses (license_id TEXT PRIMARY KEY);
CREATE TABLE staging_beta_profiles (
 username TEXT PRIMARY KEY,
 threads_user_id TEXT UNIQUE,
 user_id TEXT,
 enabled INTEGER NOT NULL DEFAULT 1,
 connected_at TEXT,
 CHECK ((threads_user_id IS NULL AND user_id IS NULL) OR (threads_user_id IS NOT NULL AND user_id IS NOT NULL))
);

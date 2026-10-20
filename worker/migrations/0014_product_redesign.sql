-- Public registration, goal-based onboarding, and manually assigned plans.
CREATE TABLE user_entitlements (
  user_id TEXT PRIMARY KEY,
  plan_code TEXT NOT NULL DEFAULT 'free',
  account_limit INTEGER NOT NULL DEFAULT 1,
  ai_advice_enabled INTEGER NOT NULL DEFAULT 0,
  platform_ai_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY,
  goal TEXT,
  activity TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  onboarding_completed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

ALTER TABLE queue ADD COLUMN media_urls_json TEXT NOT NULL DEFAULT '[]';

-- Existing users remain on Free until the operator explicitly upgrades them.
INSERT INTO user_entitlements (user_id, plan_code, account_limit, ai_advice_enabled, platform_ai_enabled, updated_at)
SELECT id, 'free', 1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM users;

-- Do not interrupt established sessions with onboarding; they can edit the profile later.
INSERT INTO user_profiles (user_id, goal, activity, audience, onboarding_completed, updated_at)
SELECT id, NULL, '', '', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM users;

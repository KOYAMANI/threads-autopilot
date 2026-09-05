-- SPEC v1.1 §4 のスキーマ。列の順序・既定値まで仕様書のまま。
-- Threads 由来の行（posts / post_metrics_history）は account_id を主キーに含める（§2.4 / B1）。

CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
  license_id TEXT NOT NULL,
  created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE licenses (
  id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'unused', -- unused|active|revoked
  note TEXT, issued_at TEXT NOT NULL, activated_at TEXT, user_id TEXT, revoked_at TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, ua TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE rate_events (                   -- 回数制限の記録（ログイン失敗・forgot・/a/* を1つのテーブルで持つ）
  key TEXT NOT NULL,                         -- 'login:<email>' | 'forgot:<email>' | 'action:<ip>'
  at TEXT NOT NULL
);
CREATE INDEX idx_rate_events ON rate_events(key, at);

CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,                       -- トークンの jti。トークン本体は保存しない
  user_id TEXT NOT NULL, token_hash TEXT NOT NULL,  -- SHA-256(token)
  expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id, created_at DESC);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, threads_user_id TEXT NOT NULL, username TEXT NOT NULL,
  name TEXT, avatar_url TEXT, color TEXT NOT NULL,
  token_enc TEXT NOT NULL, token_obtained_at TEXT NOT NULL, token_long_lived INTEGER NOT NULL DEFAULT 0,
  token_last_refresh_at TEXT, status TEXT NOT NULL DEFAULT 'ok', -- ok|needs_reauth|disabled
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', settings_json TEXT NOT NULL DEFAULT '{}',
  last_full_sync_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(user_id, threads_user_id)
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

CREATE TABLE posts (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,                          -- Threads media id（アカウントをまたぐと重複しうるので単独では主キーにしない）
  root_id TEXT NOT NULL, is_reply INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '', permalink TEXT, media_type TEXT NOT NULL DEFAULT 'TEXT_POST',
  media_url TEXT, link_attachment_url TEXT, posted_at TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0, quotes INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,            -- 按分後の推定クリック（root のみ）
  metrics_fetched_at TEXT, tags_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'external',   -- external|manual|autopilot|recycle
  queue_id TEXT, deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_id, id)
);
CREATE INDEX idx_posts_account_posted ON posts(account_id, posted_at DESC);
CREATE INDEX idx_posts_root ON posts(account_id, root_id);

CREATE TABLE post_metrics_history (
  account_id TEXT NOT NULL, post_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL,                  -- '48h'|'7d'|'30d'
  at TEXT NOT NULL,                          -- 実際に取得した時刻（記録用。主キーには入れない）
  views INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER, quotes INTEGER,
  PRIMARY KEY(account_id, post_id, checkpoint)
);
CREATE TABLE daily_views (account_id TEXT NOT NULL, date TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(account_id, date));
CREATE TABLE follower_snapshots (account_id TEXT NOT NULL, date TEXT NOT NULL, followers INTEGER NOT NULL, PRIMARY KEY(account_id, date));
CREATE TABLE demographics (account_id TEXT NOT NULL, breakdown TEXT NOT NULL, json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(account_id, breakdown));
CREATE TABLE click_weeks (
  account_id TEXT NOT NULL, week_end TEXT NOT NULL, url TEXT NOT NULL, clicks INTEGER NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY(account_id, week_end, url)
);
CREATE TABLE click_weeks_done (account_id TEXT NOT NULL, week_end TEXT NOT NULL, PRIMARY KEY(account_id, week_end));

CREATE TABLE queue (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  status TEXT NOT NULL,                      -- draft|pending_approval|scheduled|publishing|done|failed|cancelled
  scheduled_at TEXT, body TEXT NOT NULL, comments_json TEXT NOT NULL DEFAULT '[]',
  image_url TEXT, reply_control TEXT NOT NULL DEFAULT 'everyone',
  source TEXT NOT NULL DEFAULT 'manual',     -- manual|autopilot|recycle
  approval_mode TEXT,                        -- manual|cancel|auto（autopilot のみ）
  approve_deadline TEXT, notified_at TEXT,
  action_token_used_at TEXT,                 -- メールからの承認/取消トークンを使った時刻（§7.9。1回で失効）
  step INTEGER NOT NULL DEFAULT 0, next_step_at TEXT, container_id TEXT,
  container_polls INTEGER NOT NULL DEFAULT 0, -- 今の container_id を IN_PROGRESS で何回見たか（§8.3。attempts とは別物）
  result_ids_json TEXT NOT NULL DEFAULT '[]', error TEXT, error_raw TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '{}', origin_post_id TEXT, source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_queue_account_status ON queue(account_id, status, scheduled_at);
CREATE INDEX idx_queue_due ON queue(status, next_step_at);

CREATE TABLE sources (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, -- text|youtube|file|url
  title TEXT NOT NULL, url TEXT, content TEXT NOT NULL DEFAULT '', char_count INTEGER NOT NULL DEFAULT 0,
  enabled_for_ap INTEGER NOT NULL DEFAULT 1, last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE links (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',        -- line|affiliate|other
  enabled_for_ap INTEGER NOT NULL DEFAULT 1, last_used_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(account_id, url)
);

CREATE TABLE ai_settings (
  user_id TEXT PRIMARY KEY, provider TEXT NOT NULL,        -- gemini|openrouter
  key_enc TEXT, model TEXT, store_on_server INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE autopilot (
  account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
  per_week INTEGER NOT NULL DEFAULT 7,       -- 週あたり本数（1日1本=7, 1日2本=14, 週3本=3, 週5本=5）
  slot_mode TEXT NOT NULL DEFAULT 'auto',    -- auto|fixed
  fixed_hour INTEGER, approval_mode TEXT NOT NULL DEFAULT 'cancel', -- manual|cancel|auto
  approval_window_h INTEGER NOT NULL DEFAULT 4, daily_limit INTEGER NOT NULL DEFAULT 1,
  quiet_hours INTEGER NOT NULL DEFAULT 1,    -- 0〜6時は出さない
  ng_words TEXT NOT NULL DEFAULT '', link_placement TEXT NOT NULL DEFAULT 'comment', -- comment|body|none
  hook_mode TEXT NOT NULL DEFAULT 'auto', fixed_hook TEXT, score_weights TEXT NOT NULL DEFAULT 'balanced', -- balanced|followers|clicks
  consecutive_failures INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE learning (
  account_id TEXT NOT NULL, dim TEXT NOT NULL, value TEXT NOT NULL, -- dim: hook|slot|length|source
  n INTEGER NOT NULL DEFAULT 0, score_sum REAL NOT NULL DEFAULT 0,
  views_sum INTEGER NOT NULL DEFAULT 0, like_rate_sum REAL NOT NULL DEFAULT 0,  -- 画面表示用の素の集計（§7.7）
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, dim, value)
);
CREATE TABLE ap_log (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, ref_id TEXT);
CREATE INDEX idx_ap_log ON ap_log(account_id, at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, account_id TEXT, state_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|running|done|failed
  priority INTEGER NOT NULL DEFAULT 5, next_run_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, next_run_at, priority);

CREATE TABLE notifications (
  user_id TEXT PRIMARY KEY, email_enabled INTEGER NOT NULL DEFAULT 1, push_enabled INTEGER NOT NULL DEFAULT 0,
  digest_hour INTEGER NOT NULL DEFAULT 8, updated_at TEXT NOT NULL
);
CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);

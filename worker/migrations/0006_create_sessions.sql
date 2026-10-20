-- Claude 連携（DECISIONS「Claude 連携」）。Create 画面の「Claude で作る」1回＝1行。
-- payload は画面で選んだ材料（accountId / pickMode / picks / referenceText / sourceIds / instruction）。
-- 投稿本文そのものは持たない。MCP ツールが読むたびに posts / sources から引き直す。
-- candidates は Claude が save_candidates で書き戻した案（AiCandidate[] の JSON）。
-- 退会・アカウント削除では外部キーの CASCADE で消える（threads_oauth_states と同じ）。
-- 削除のバッチに文を足すと、free プランの D1 クエリ上限（32）を超えるため。
CREATE TABLE create_sessions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 payload TEXT NOT NULL,
 candidates TEXT,
 status TEXT NOT NULL DEFAULT 'waiting', -- waiting|ready
 created_at TEXT NOT NULL
);
CREATE INDEX idx_create_sessions_user ON create_sessions(user_id, created_at);

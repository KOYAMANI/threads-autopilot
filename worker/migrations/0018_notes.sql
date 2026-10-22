-- note 記事（長文）。章ごとに本文を持ち、ジョブ `note_write` が順に書く（SPEC §7.10 / §8.2）。
-- 退会・アカウント削除は FK の CASCADE で消える（0007 の posting_slots と同じ。削除の文数を増やさない）。
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  title_options_json TEXT NOT NULL DEFAULT '[]',
  memo TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT 'general',       -- story|general
  volume TEXT NOT NULL DEFAULT 'standard',     -- short|standard|same
  ref_note TEXT NOT NULL DEFAULT '',
  ref_profile_json TEXT,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  outline_json TEXT,
  paywall_after INTEGER,
  qa_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',        -- draft|outlined|writing|done
  engine TEXT NOT NULL DEFAULT 'gemini',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_notes_owner ON notes(user_id, account_id, updated_at);

CREATE TABLE note_sections (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL,
  target_chars INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  char_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'todo',         -- todo|writing|done|failed
  error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(note_id, ord)
);
CREATE INDEX idx_note_sections_note ON note_sections(note_id, ord);

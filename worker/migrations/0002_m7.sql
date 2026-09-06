-- M7（SPEC §13 M7）。
--
-- 1. `notifications.last_digest_date` … 日次ダイジェスト（`daily_digest` ジョブ）を
--    その買い手にその日もう送ったかの印。アカウントの timezone での「日付」を入れる。
--    毎時の cron が同じ時刻帯を2回踏んでも二重に送らないため。
-- 2. `push_subscriptions.last_error_at` / `fail_count` … 送信に失敗した購読の記録。
--    404/410（購読が消えている）は即その場で行を消すが、それ以外の失敗は
--    数えておいて、続くようなら送信の対象から外す。

ALTER TABLE notifications ADD COLUMN last_digest_date TEXT;
ALTER TABLE push_subscriptions ADD COLUMN last_error_at TEXT;
ALTER TABLE push_subscriptions ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;

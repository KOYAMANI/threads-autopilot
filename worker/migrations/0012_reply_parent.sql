-- Preserve the direct reply target; root_id alone cannot distinguish conversation replies.
ALTER TABLE posts ADD COLUMN reply_to_id TEXT;

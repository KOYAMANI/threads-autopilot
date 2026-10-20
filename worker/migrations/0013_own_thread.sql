-- Verified direct self-reply chain; legacy root_id grouping is not evidence of ownership.
ALTER TABLE posts ADD COLUMN own_thread_json TEXT;

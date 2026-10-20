CREATE TABLE media_objects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_media_objects_expires_at ON media_objects(expires_at);
CREATE INDEX idx_media_objects_user_id ON media_objects(user_id);

CREATE TRIGGER cleanup_user_media_data
AFTER DELETE ON users
BEGIN
  DELETE FROM media_objects WHERE user_id = OLD.id;
END;

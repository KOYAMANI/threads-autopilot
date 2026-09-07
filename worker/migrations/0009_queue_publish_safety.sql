-- Record a root publication independently of mutable queue status/update time.
ALTER TABLE queue ADD COLUMN root_published_at TEXT;
-- Prefer the imported root post timestamp for historical rows. Rows that failed
-- after root publication may have no posts row; updated_at is a conservative
-- historical fallback, not a claim of an exact provider publication timestamp.
UPDATE queue SET root_published_at=COALESCE(
  (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',replace(p.posted_at,'+0000','Z')) FROM posts p WHERE p.account_id=queue.account_id
    AND p.id=json_extract(queue.result_ids_json,'$[0]') AND p.is_reply=0 LIMIT 1),
  strftime('%Y-%m-%dT%H:%M:%fZ',updated_at),updated_at
) WHERE CASE WHEN json_valid(result_ids_json) THEN json_array_length(result_ids_json) ELSE 0 END>0;
CREATE INDEX queue_root_publication_day ON queue(account_id,root_published_at)
  WHERE root_published_at IS NOT NULL;
CREATE TRIGGER queue_root_publication_immutable BEFORE UPDATE OF root_published_at ON queue
WHEN OLD.root_published_at IS NOT NULL AND NEW.root_published_at IS NOT OLD.root_published_at
BEGIN
  SELECT RAISE(ABORT, 'ROOT_PUBLICATION_TIME_IMMUTABLE');
END;

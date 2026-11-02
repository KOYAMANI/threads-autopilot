-- Images per thread segment (DECISIONS 2026-10-30). media_json[0] is the root post, media_json[i] is comments[i-1].
-- media_state_json holds the carousel child container ids of the segment being published.
ALTER TABLE queue ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE queue ADD COLUMN media_state_json TEXT;
UPDATE queue SET media_json = json_array(json_array(json_object('url', image_url))) WHERE image_url IS NOT NULL AND image_url <> '';

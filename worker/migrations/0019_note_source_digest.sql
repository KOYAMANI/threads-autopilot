-- note: 本文の無い YouTube 資料を Gemini に見せて書き出した要点（source id → 要点）。
-- 目次の前に1回だけ作り、目次と各章はこれを資料として使う（動画を章ごとに読ませない）。
ALTER TABLE notes ADD COLUMN source_digest_json TEXT NOT NULL DEFAULT '{}';

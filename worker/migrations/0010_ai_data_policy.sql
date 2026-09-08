-- Existing keys remain stored; no consent is inferred for existing users.
ALTER TABLE ai_settings ADD COLUMN data_policy_version TEXT;

-- Keep product-specific rows inside the existing fixed-cost account deletion path.
-- The application deletes the user once; SQLite performs this cleanup atomically
-- without adding two separately budgeted D1 statements.
CREATE TRIGGER cleanup_user_product_data
AFTER DELETE ON users
BEGIN
  DELETE FROM user_entitlements WHERE user_id = OLD.id;
  DELETE FROM user_profiles WHERE user_id = OLD.id;
END;

-- The user's own order for their accounts (drawer drag-and-drop). NULL = never
-- reordered; those sort after ordered rows, oldest first, so existing users and
-- newly connected accounts keep the previous created_at order.
ALTER TABLE accounts ADD COLUMN sort_order INTEGER;

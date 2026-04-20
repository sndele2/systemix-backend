CREATE TABLE IF NOT EXISTS internal_users (
  id TEXT PRIMARY KEY,
  business_number TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'operator')),
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_internal_users_business_number
  ON internal_users(business_number);

CREATE INDEX IF NOT EXISTS idx_internal_users_role_active
  ON internal_users(role, is_active);

ALTER TABLE internal_sessions ADD COLUMN user_id TEXT;
ALTER TABLE internal_sessions ADD COLUMN role TEXT;
ALTER TABLE internal_sessions ADD COLUMN business_number TEXT;

CREATE INDEX IF NOT EXISTS idx_internal_sessions_user_id
  ON internal_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_internal_sessions_business_number
  ON internal_sessions(business_number);

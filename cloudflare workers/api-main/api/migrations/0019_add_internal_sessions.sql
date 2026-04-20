-- AUTH_REPLACE_LATER: Temporary operator session storage for the internal inbox and GTM routes.
CREATE TABLE IF NOT EXISTS internal_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT
);

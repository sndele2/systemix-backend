CREATE TABLE IF NOT EXISTS active_sessions (
  id TEXT PRIMARY KEY,
  business_number TEXT NOT NULL,
  customer_number TEXT NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_active_sessions_business_status
  ON active_sessions(business_number, status, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_active_sessions_thread
  ON active_sessions(thread_id);

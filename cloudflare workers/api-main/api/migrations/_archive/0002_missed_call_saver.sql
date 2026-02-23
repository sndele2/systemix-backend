CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  call_sid TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  forward_to_phone TEXT,
  followup_sent_at TEXT,
  followup_message_sid TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS calls_created_at_idx ON calls(created_at);
CREATE INDEX IF NOT EXISTS calls_from_phone_idx ON calls(from_phone);
CREATE INDEX IF NOT EXISTS calls_call_sid_idx ON calls(call_sid);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT,
  message_sid TEXT UNIQUE,
  call_sid TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
CREATE INDEX IF NOT EXISTS messages_call_sid_idx ON messages(call_sid);

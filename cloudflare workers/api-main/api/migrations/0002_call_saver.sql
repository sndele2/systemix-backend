CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  missed_at TEXT,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  status TEXT NOT NULL,
  followup_sent_at TEXT,
  followup_message_id TEXT,
  last_inbound_message_id TEXT,
  opt_out INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS calls_provider_call_id_idx ON calls(provider, provider_call_id);
CREATE INDEX IF NOT EXISTS calls_created_at_idx ON calls(created_at);
CREATE INDEX IF NOT EXISTS calls_from_phone_idx ON calls(from_phone);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  body TEXT,
  call_id TEXT,
  raw_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_message_id_idx ON messages(provider, provider_message_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
CREATE INDEX IF NOT EXISTS messages_call_id_idx ON messages(call_id);

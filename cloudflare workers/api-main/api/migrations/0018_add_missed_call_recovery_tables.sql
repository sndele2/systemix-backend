-- `businesses.intake_question` is added by the runtime schema guard in
-- `src/services/missedCallRecovery.ts` so existing databases can upgrade
-- without a duplicate-column migration failure.

CREATE TABLE IF NOT EXISTS missed_call_conversations (
  id TEXT PRIMARY KEY,
  business_number TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  missed_call_timestamp TEXT NOT NULL,
  sms_sent INTEGER NOT NULL DEFAULT 0,
  sms_content TEXT,
  reply_received INTEGER NOT NULL DEFAULT 0,
  reply_text TEXT,
  reply_timestamp TEXT,
  time_to_reply_seconds INTEGER,
  is_ignored INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_missed_call_conversations_business_phone
  ON missed_call_conversations(business_number, phone_number, missed_call_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_missed_call_conversations_business_reply
  ON missed_call_conversations(business_number, reply_received, missed_call_timestamp DESC);

CREATE TABLE IF NOT EXISTS missed_call_ignored_numbers (
  id TEXT PRIMARY KEY,
  business_number TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_call_ignored_numbers_business_phone
  ON missed_call_ignored_numbers(business_number, phone_number);

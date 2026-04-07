CREATE TABLE IF NOT EXISTS sms_opt_outs (
  id TEXT PRIMARY KEY,
  business_number TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  is_opted_out INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_opt_outs_business_phone
  ON sms_opt_outs(business_number, phone_number);

CREATE INDEX IF NOT EXISTS idx_sms_opt_outs_business_status
  ON sms_opt_outs(business_number, is_opted_out, updated_at DESC);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  business_number TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  source TEXT NOT NULL,
  consent_given INTEGER NOT NULL,
  consent_text TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_consents_business_phone_created
  ON consents(business_number, phone_number, created_at DESC);

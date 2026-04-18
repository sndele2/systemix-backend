-- GTM reply inbox storage.
-- These tables stay aligned with the existing GTM non-tenant model introduced in 0016.

CREATE TABLE IF NOT EXISTS gtm_replies (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES gtm_leads(id),
  from_email TEXT NOT NULL,
  subject TEXT,
  body_snippet TEXT,
  received_at TEXT NOT NULL,
  conversation_id TEXT,
  classification TEXT NOT NULL DEFAULT 'unknown',
  sequence_stopped INTEGER NOT NULL DEFAULT 0
    CHECK (sequence_stopped IN (0, 1)),
  raw_provider_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gtm_replies_received_at
  ON gtm_replies(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_gtm_replies_lead_id_received_at
  ON gtm_replies(lead_id, received_at DESC);

CREATE TABLE IF NOT EXISTS gtm_sync_cursor (
  id TEXT PRIMARY KEY DEFAULT 'gtm-reply-cursor',
  last_synced_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO gtm_sync_cursor (id, last_synced_at, updated_at)
VALUES ('gtm-reply-cursor', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
ON CONFLICT(id) DO NOTHING;

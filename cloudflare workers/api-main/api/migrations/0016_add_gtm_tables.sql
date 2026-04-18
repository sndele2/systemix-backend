-- GTM storage for Systemix-internal prospect records.
-- These tables are intentionally NOT tenant-scoped because GTM leads are not onboarded tenants.
-- Do not add tenant_id or business_number columns here unless the GTM product model changes.

CREATE TABLE IF NOT EXISTS gtm_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'replied', 'converted', 'exhausted', 'opted_out', 'error')),
  touches_sent INTEGER NOT NULL DEFAULT 0
    CHECK (touches_sent >= 0 AND touches_sent <= 3),
  last_stage_index INTEGER
    CHECK (last_stage_index IS NULL OR last_stage_index BETWEEN 0 AND 2),
  last_sent_at TEXT,
  stopped_at TEXT,
  created_at TEXT NOT NULL,
  -- Metadata is stored as a JSON string and must be cast explicitly on read/write.
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS gtm_touchpoints (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES gtm_leads(id),
  stage_index INTEGER NOT NULL
    CHECK (stage_index BETWEEN 0 AND 2),
  sent_at TEXT NOT NULL,
  -- D1 stores booleans as INTEGER values, so dry_run uses 0/1.
  dry_run INTEGER NOT NULL DEFAULT 1
    CHECK (dry_run IN (0, 1)),
  result TEXT NOT NULL
    CHECK (result IN ('success', 'error', 'skipped')),
  message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_gtm_touchpoints_lead_id_sent_at
  ON gtm_touchpoints(lead_id, sent_at DESC);

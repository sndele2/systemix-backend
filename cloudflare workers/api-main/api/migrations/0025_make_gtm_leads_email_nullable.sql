-- Step 1: Recreate gtm_leads with email nullable
CREATE TABLE gtm_leads_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
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
  metadata TEXT,
  experiment_tag TEXT,
  outreach_window TEXT,
  context_note TEXT
);

-- Step 2: Copy existing data
INSERT INTO gtm_leads_new SELECT * FROM gtm_leads;

-- Step 3: Drop dependent tables first
DROP TABLE gtm_approvals;
DROP TABLE gtm_touchpoints;
DROP TABLE gtm_leads;

-- Step 4: Promote new table
ALTER TABLE gtm_leads_new RENAME TO gtm_leads;

-- Step 5: Recreate dependent tables
CREATE TABLE gtm_touchpoints (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES gtm_leads(id),
  stage_index INTEGER NOT NULL
    CHECK (stage_index BETWEEN 0 AND 2),
  sent_at TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 1
    CHECK (dry_run IN (0, 1)),
  result TEXT NOT NULL
    CHECK (result IN ('success', 'error', 'skipped')),
  message_id TEXT,
  experiment_tag TEXT NOT NULL DEFAULT '',
  outreach_window TEXT NOT NULL DEFAULT '',
  context_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE gtm_approvals (
  id TEXT PRIMARY KEY,
  approval_code TEXT NOT NULL UNIQUE,
  lead_id TEXT NOT NULL REFERENCES gtm_leads(id),
  stage_index INTEGER NOT NULL
    CHECK (stage_index BETWEEN 0 AND 2),
  proposal_hash TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
  requested_at TEXT NOT NULL,
  notified_at TEXT,
  decision_at TEXT,
  decided_by_phone TEXT,
  executed_at TEXT
);

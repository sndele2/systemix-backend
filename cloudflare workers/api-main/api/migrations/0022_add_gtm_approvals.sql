-- GTM approval queue for approval-gated outbound execution.
-- Each row represents one concrete outbound proposal awaiting owner approval by SMS.

CREATE TABLE IF NOT EXISTS gtm_approvals (
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

CREATE INDEX IF NOT EXISTS idx_gtm_approvals_lead_stage_requested_at
  ON gtm_approvals(lead_id, stage_index, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_gtm_approvals_status_requested_at
  ON gtm_approvals(status, requested_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gtm_approvals_unique_pending_proposal
  ON gtm_approvals(lead_id, stage_index, proposal_hash)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  business_number TEXT,
  phone_number TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  source TEXT,
  summary TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_request_id
  ON workflow_runs(request_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_name
  ON workflow_runs(workflow_name);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_business_number
  ON workflow_runs(business_number);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at
  ON workflow_runs(created_at);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  input_json TEXT,
  output_json TEXT,
  error_text TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_request_id
  ON workflow_steps(request_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run_id
  ON workflow_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_step_name
  ON workflow_steps(step_name);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_created_at
  ON workflow_steps(created_at);

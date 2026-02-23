CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT,
  name TEXT,
  phone TEXT,
  email TEXT,
  service TEXT,
  location TEXT,
  details TEXT,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prequotes (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  service TEXT,
  location TEXT,
  urgency TEXT,
  budget TEXT,
  details TEXT,
  status TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  result_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_prequotes_created_at ON prequotes(created_at);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS widget_sites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  public_key TEXT NOT NULL UNIQUE,
  allowed_domains TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_active INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE prequotes ADD COLUMN tenant_id TEXT;
ALTER TABLE prequotes ADD COLUMN site_id TEXT;
ALTER TABLE prequotes ADD COLUMN conversation_id TEXT;

ALTER TABLE leads ADD COLUMN tenant_id TEXT;
ALTER TABLE leads ADD COLUMN site_id TEXT;
ALTER TABLE leads ADD COLUMN conversation_id TEXT;

CREATE INDEX IF NOT EXISTS prequotes_site_created_at_idx ON prequotes(site_id, created_at);
CREATE INDEX IF NOT EXISTS prequotes_conversation_id_idx ON prequotes(conversation_id);
CREATE INDEX IF NOT EXISTS leads_site_created_at_idx ON leads(site_id, created_at);

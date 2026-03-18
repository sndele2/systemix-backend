-- No-op migration marker.
-- Verified on 2026-03-12 that both remote databases already include:
-- businesses.created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
-- businesses.updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
SELECT 1;

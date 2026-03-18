CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  business_number TEXT NOT NULL UNIQUE,
  owner_phone_number TEXT,
  display_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_businesses_business_number ON businesses(business_number);
CREATE INDEX IF NOT EXISTS idx_businesses_owner_phone_number ON businesses(owner_phone_number);

INSERT INTO businesses (
  id,
  business_number,
  owner_phone_number,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),
  m.from_phone,
  m.to_phone,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM messages m
WHERE m.direction = 'outbound'
  AND m.from_phone IS NOT NULL
  AND m.from_phone != ''
  AND m.to_phone IS NOT NULL
  AND m.to_phone != ''
  AND json_valid(COALESCE(m.raw_json, '{}')) = 1
  AND COALESCE(json_extract(m.raw_json, '$.source'), '') IN (
    'owner_sms_reply_alert',
    'standard_owner_alert',
    'owner_emergency_alert',
    'owner_command_response',
    'owner_relay_confirmation'
  )
GROUP BY m.from_phone, m.to_phone
ON CONFLICT(business_number) DO UPDATE SET
  owner_phone_number = CASE
    WHEN businesses.owner_phone_number IS NULL OR businesses.owner_phone_number = ''
    THEN excluded.owner_phone_number
    ELSE businesses.owner_phone_number
  END,
  updated_at = excluded.updated_at;

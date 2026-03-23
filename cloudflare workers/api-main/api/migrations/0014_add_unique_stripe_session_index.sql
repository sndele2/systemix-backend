CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_last_stripe_session_id_unique
ON businesses(last_stripe_session_id)
WHERE last_stripe_session_id IS NOT NULL
  AND last_stripe_session_id != '';

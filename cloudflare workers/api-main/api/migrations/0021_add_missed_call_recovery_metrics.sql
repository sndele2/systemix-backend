ALTER TABLE missed_call_conversations ADD COLUMN first_auto_text_at TEXT;
ALTER TABLE missed_call_conversations ADD COLUMN first_customer_reply_at TEXT;
ALTER TABLE missed_call_conversations ADD COLUMN recovered_opportunity_at TEXT;

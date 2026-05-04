-- Timing experiment metadata for GTM leads and send executions.

ALTER TABLE gtm_leads ADD COLUMN experiment_tag TEXT;
ALTER TABLE gtm_leads ADD COLUMN outreach_window TEXT;
ALTER TABLE gtm_leads ADD COLUMN context_note TEXT;

ALTER TABLE gtm_touchpoints ADD COLUMN experiment_tag TEXT NOT NULL DEFAULT '';
ALTER TABLE gtm_touchpoints ADD COLUMN outreach_window TEXT NOT NULL DEFAULT '';
ALTER TABLE gtm_touchpoints ADD COLUMN context_note TEXT NOT NULL DEFAULT '';

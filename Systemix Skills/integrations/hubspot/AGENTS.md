---
name: Systemix HubSpot Sync Rules
description: Guidelines for synchronizing Systemix data to HubSpot CRM.
color: "#228B22"
---

## Identity & Memory

This file governs the background tasks that sync lead and business data to HubSpot using the Companies and Contacts APIs.  It remembers that HubSpot is a high‑latency API subject to rate limits and that synchronization must never disrupt inbound lead flows.

## Core Mission

Mirror the D1 state to HubSpot asynchronously without disrupting lead notification flows or causing data inconsistency.

## Critical Rules

1. **Background sync only:** Do not call HubSpot from synchronous webhook handlers.  Always schedule the sync via `ctx.waitUntil` or other background job mechanisms.
2. **Rate‑limit handling:** Implement exponential backoff or queueing for HTTP 429 responses.  Never drop data silently; log and retry.
3. **Property mapping:** Maintain a stable mapping between Systemix fields and HubSpot custom properties (e.g., `systemix_ai_summary` → long text field, `systemix_lead_type` → enumerated).  Do not change these names without updating HubSpot definitions and sync code.
4. **Idempotency:** Ensure sync operations are idempotent; avoid creating duplicate companies or contacts.  Use HubSpot IDs or deduplication keys (such as `business_number`).
5. **Security:** Use API keys or tokens stored in environment variables; never log or expose them.

## Technical Deliverables

- Functions to upsert companies and contacts in HubSpot based on D1 records.
- Retry logic with backoff for API limits and transient errors.
- Tests verifying that sync does not affect webhook response times.

## Workflow Process

1. When a lead is created or updated, schedule a background sync job.
2. Fetch the latest data from D1; map it to HubSpot fields.
3. Call HubSpot’s APIs (batch if possible) within the background context.
4. Handle rate‑limit responses by rescheduling the job.
5. Update D1 with HubSpot IDs or sync status as needed.

## Success Metrics

- HubSpot updates eventually reflect the D1 state without manual intervention.
- No CRM errors propagate to customer‑facing flows.
- High reliability under rate limits.
- Data in HubSpot remains consistent with D1 after sync.
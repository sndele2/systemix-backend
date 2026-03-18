---
name: hubspot-sync-review
version: 1.0.0
description: Assess HubSpot sync code for reliability and non‑disruptive behaviour.
---

## Purpose

Use this skill to review or generate code that syncs Systemix data to HubSpot.  It ensures the sync adheres to asynchronous, idempotent and safe patterns.

## Checklist

1. **Async execution:** Sync code must be invoked via `ctx.waitUntil` or background jobs, not in the webhook response path.
2. **Rate limit handling:** Implement retries with backoff when receiving HTTP 429 or 5xx responses from HubSpot.
3. **Field mapping:** Use the defined property mapping; do not introduce or rename properties without migrating both ends.
4. **Idempotency:** Use deduplication keys (e.g., `business_number` or HubSpot ID) to avoid duplicate companies/contacts.
5. **Error logging:** Log errors for monitoring but do not throw; requeue jobs as needed.

## Evaluation

- Inspect the code to see if API calls are made synchronously.
- Check for proper handling of error responses and retries.
- Verify that updates to D1 include storing HubSpot IDs or sync status.

## Success

- No negative impact on lead ingestion latency.
- Reliable completion of HubSpot sync operations.
- Data consistency between D1 and HubSpot after sync.
---
name: Systemix Global Rules
description: Repository‑wide guidelines for editing and building Systemix.
color: "#006400"
---

## Identity & Memory

This agent file acts as the repository‑wide policy for editing Systemix using Codex.  It knows about the entire architecture described in this repository: Cloudflare Workers running in V8 isolates, a D1 database keyed by `business_number` for tenant isolation, an AI orchestration layer for semantic intent classification, distinct webhook entry points for Stripe, Twilio and internal onboarding, and asynchronous CRM synchronization.  It persists these guidelines across all tasks so that changes remain aligned with the core system design.

## Core Mission

Ensure that any change across Systemix abides by the platform’s architectural invariants:

- Maintain sub‑10ms median response times for edge requests by avoiding blocking I/O.
- Uphold multi‑tenant safety by always scoping data using `business_number` and preserving relational integrity in the D1 schema.
- Preserve strict JSON‑only AI outputs for semantic intent classification.
- Keep webhook handlers responsive (HTTP 200) by offloading long‑running tasks via `ctx.waitUntil` and other asynchronous workflows.
- Ensure eventual consistency with external CRMs without impacting core flow reliability.

## Critical Rules

1. **Edge performance:** Never introduce synchronous network or database calls or heavy dependencies in Cloudflare Worker fetch handlers.  Always use asynchronous calls with `ctx.waitUntil` for work that can complete after the response is sent.
2. **Data integrity:** Do not modify the D1 schema without preserving the unique `business_number` constraint and upsert semantics.  Avoid cross‑tenant data leakage by always including `business_number` in queries and primary keys.
3. **AI outputs:** LLM responses must be machine‑parseable JSON; do not allow stray tokens or conversational text.  Strip unnecessary metadata from Twilio payloads before inference to reduce token usage.
4. **Webhook safety:** Stripe and Twilio endpoints must always validate signatures or Authorization headers before processing; respond with HTTP 200 immediately; do not perform long tasks within the synchronous path.
5. **Security:** Respect environment variables for secrets; never hard‑code keys; keep internal endpoints protected by proper Authorization headers.
6. **Reliability:** External API failures (HubSpot, OpenAI) must not impact the acknowledgement of inbound webhooks or degrade user experience.  Use retry/backoff and eventual consistency.
7. **Testing:** When editing code, run and update unit tests and integration tests.  Add tests for new features and edge cases.

## Technical Deliverables

- Code or configuration files that adhere to these constraints.
- Unit and integration tests verifying latency, integrity and security.
- Migration scripts for database changes that are safe to run in production.

## Workflow Process

1. Identify the relevant submodule (worker, database, AI, integrations) and consult its local `AGENTS.md` for more specific guidelines.
2. Make changes in a local branch with clear commit messages (use conventional commits).
3. Run tests and linters; fix issues before committing.
4. When adding new features, update documentation and relevant skills or agent files.
5. Create a pull request; request code review; incorporate feedback before merging.

## Success Metrics

- No regression in median response time for critical endpoints (< 10 ms).
- No production incidents triggered by schema or code changes.
- 100 % passing tests with added coverage for new features.
- Verified correct behaviour in staging through manual or automated tests.
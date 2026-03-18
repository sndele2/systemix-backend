---
name: Systemix Worker API Rules
description: Guidelines for editing Cloudflare Worker endpoints and handling webhooks.
color: "#1E90FF"
---

## Identity & Memory

This file provides specific guidance for editing or creating Cloudflare Worker code in `workers/api`.  It knows the runtime is Cloudflare Workers using V8 isolates with single‑digit millisecond execution, event‑driven I/O and a concurrency limit of around 50 k requests per second.  It persists memory about signature validation, environment constraints and latency budgets across tasks.

## Core Mission

Ensure Worker handlers remain stateless, fast, secure and robust when processing Stripe, Twilio and internal onboarding webhooks.

## Critical Rules

1. **Non‑blocking fetch handlers:** Immediately return an HTTP 200 response to webhook providers.  Move long‑running operations (database writes, LLM calls, CRM sync) into `ctx.waitUntil` tasks.
2. **Signature/auth validation:** Always verify `Stripe‑Signature` for Stripe events and check `Authorization` headers for internal onboarding.  Do not process a webhook if validation fails.
3. **Supported APIs:** Use the Fetch API and Cloudflare KV/D1 via provided bindings.  Avoid Node.js modules or libraries not supported in the V8 isolate environment (e.g., `fs`, `crypto` from Node).  Use the Web Crypto API for hashing and HMAC.
4. **Error handling:** Catch and log exceptions within handlers.  Do not leak stack traces or secrets.  Fail closed for unknown event types.
5. **Latency budgeting:** Any synchronous computations must complete in microseconds; avoid loops over large datasets; do not block on I/O.

## Technical Deliverables

- Worker functions that acknowledge events and schedule background tasks.
- Implementation of `ctx.waitUntil` to call OpenAI, HubSpot or other services asynchronously.
- Secure signature validation logic using the Web Crypto API.
- Clear separation between the synchronous path (webhook acknowledgment) and asynchronous tasks.

## Workflow Process

1. Determine the webhook type (`stripe`, `twilio`, `internal`) and validate the incoming request accordingly.
2. In the fetch handler, parse required fields (e.g., `Body`, `From`, `metadata`) and respond with `new Response('', { status: 200 })`.
3. Use `ctx.waitUntil` to call D1, send data to OpenAI or sync with HubSpot.
4. Test new endpoints locally using Cloudflare Wrangler or by mocking fetch events.
5. Document any new environment variables or binding requirements.

## Success Metrics

- All webhook endpoints return HTTP 200 with no timeouts.
- Signature validation passes for legitimate events and fails for tampered ones.
- Background tasks complete successfully without blocking the fetch event.
- Endpoints remain under 10 ms median compute time.
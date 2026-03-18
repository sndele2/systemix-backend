---
name: webhook-safety-check
version: 1.0.0
description: Evaluate webhook handlers for security and responsiveness.
---

## Purpose

Trigger this skill when reviewing changes to webhook endpoints for Stripe, Twilio or internal onboarding to ensure they remain secure and fast.

## Steps

1. **Signature validation:** Confirm the handler verifies the `Stripe‑Signature` or `Authorization` headers with the correct secret before processing.
2. **Early acknowledgement:** The function must respond with HTTP 200 immediately; heavy tasks should be scheduled in `ctx.waitUntil`.
3. **Error handling:** All exceptions must be caught; never leak stack traces.  Unknown event types should be logged and ignored safely.
4. **Input sanitization:** Extract only required fields from the payload; ignore or explicitly handle unknown properties.

## Evaluation

- Review the diff to identify modifications to validation logic, response codes or asynchronous scheduling.
- Flag any addition of synchronous network or database calls in the synchronous path.
- Ensure new environment variables or secrets are used correctly.

## Success

- Webhook endpoints process valid events and ignore invalid ones.
- Response latency remains under 10 ms.
- No security regressions or unhandled exceptions are introduced.
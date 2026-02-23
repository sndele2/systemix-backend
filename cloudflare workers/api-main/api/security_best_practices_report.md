# Security Best Practices Report

## Executive Summary
The codebase has multiple externally reachable webhook endpoints that perform privileged actions (database writes, outbound SMS, and third-party API calls) without authenticating the sender. The highest-risk issue is a credential-leak vector where Twilio Basic Auth credentials can be sent to an attacker-controlled URL. Immediate priorities are: (1) enforce Twilio signature verification on all Twilio webhooks, (2) block credential exfiltration in recording fetch, and (3) lock down the simulation endpoint in production.

## Critical Findings

### SBP-001
- Severity: Critical
- Location: `src/index.ts:22`, `src/index.ts:25`, `src/index.ts:28`, `src/webhooks/twilioVoice.ts:21`, `src/webhooks/twilioVoice.ts:50`, `src/webhooks/twilioSms.ts:10`
- Evidence: Public webhook routes process requests directly; no `X-Twilio-Signature` verification logic exists in the codebase.
- Impact: Any internet client can forge webhook requests, trigger DB writes, invoke OpenAI/Twilio calls, and send SMS at your expense.
- Fix: Implement Twilio request validation for `/v1/webhooks/twilio/voice`, `/v1/webhooks/twilio/recording`, and `/v1/webhooks/twilio/sms` using `TWILIO_AUTH_TOKEN`; enforce in production.
- Mitigation: Restrict ingress at edge/WAF to Twilio IP ranges as a temporary control.

### SBP-002
- Severity: Critical
- Location: `src/webhooks/twilioVoice.ts:94-103`
- Evidence: Recording download always sets `Authorization: Basic <TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN>` while `recordingUrl` is request-derived.
- Impact: An attacker can post a crafted `RecordingUrl` to force credential-bearing requests to attacker infrastructure, exfiltrating Twilio credentials.
- Fix: Only attach Twilio auth when hostname is trusted Twilio media host(s), otherwise reject. Pair with webhook signature verification.
- Mitigation: Rotate `TWILIO_AUTH_TOKEN` immediately after fixing.

## High Findings

### SBP-003
- Severity: High
- Location: `src/index.ts:31`, `src/testing/simulator.ts:3-34`
- Evidence: `/test/simulate-callback` is publicly exposed and accepts arbitrary JSON, then triggers `processCall(...)` background processing.
- Impact: Unauthenticated abuse can generate SMS/API costs and flood logs/DB.
- Fix: Disable route in production, or protect with API key/mTLS/signature validation and strict rate limiting.
- Mitigation: Add environment gate (`if ENVIRONMENT==='production' return 404`).

### SBP-004
- Severity: High
- Location: `src/webhooks/twilioVoice.ts:42`, `src/webhooks/twilioVoice.ts:69-75`, `src/webhooks/twilioVoice.ts:144`, `src/webhooks/twilioVoice.ts:210`
- Evidence: Logs include full TwiML payload with phone metadata, caller numbers, and transcription content.
- Impact: PII/lead data can leak through log access and retention pipelines.
- Fix: Redact or hash phone numbers, avoid logging transcript/body text, and use structured minimal logs.
- Mitigation: Tighten log retention/access policies.

## Medium Findings

### SBP-005
- Severity: Medium
- Location: `src/webhooks/twilioVoice.ts:220`
- Evidence: Error response returns `String(error)` directly in JSON.
- Impact: Internal stack/details may be disclosed to unauthenticated callers.
- Fix: Return generic error messages externally; keep details only in internal logs.
- Mitigation: Add centralized error sanitizer.

### SBP-006
- Severity: Medium
- Location: `src/index.ts:22-31`
- Evidence: No visible request throttling/abuse control for webhook endpoints.
- Impact: Brute-force/spam requests can increase cost and degrade service.
- Fix: Add edge rate limits (Cloudflare Rules) and per-route abuse controls.
- Mitigation: Add idempotency keys and duplicate suppression for SMS sends.

## Low Findings

### SBP-007
- Severity: Low
- Location: `src/webhooks/twilioVoice.ts:37`
- Evidence: Callback URL embeds `from`/`to` in query string.
- Impact: Phone numbers can appear in URL logs and observability systems.
- Fix: Use `CallSid` correlation and lookup instead of carrying phone data in query params.
- Mitigation: If kept, mask query strings in logs.

## Recommended Remediation Order
1. Implement and enforce Twilio signature verification on all Twilio webhooks.
2. Restrict recording fetch auth headers to trusted Twilio hosts only; rotate Twilio auth token.
3. Lock down or disable `/test/simulate-callback` in production.
4. Redact PII in logs and sanitize external error responses.
5. Add edge-level rate limiting and idempotency controls.

# GTM Module Rules

This folder owns the outbound GTM workflow scaffold for missed-call recovery / lost job re-engagement. Keep all GTM logic isolated here and treat this file as the local governance for future work.

## Scope

- Outbound GTM only.
- Positioning is missed-call recovery for leads who did not book within 24 hours.
- Plain-text email only. Do not add HTML email support in this module.

## Non-Negotiable Rules

- Do not import from Twilio, SMS, or other core production paths outside `src/gtm/`.
- Do not modify or wrap existing Twilio webhook handlers, SMS handlers, signature validation, or router code from this module.
- `dryRun` defaults to `true`; live sending requires explicit opt-in.
- Sequence stops on any inbound reply.
- Max 3 touches per lead. This is a hard code-level ceiling.
- Persist lead state to durable storage before any email dispatch. If persistence fails, do not send.
- Tests are required for every new behavior added in this folder.

## Forbidden Imports

- `../webhooks/twilioVoice.ts`
- `../webhooks/twilioSms.ts`
- `../webhooks/twilioStatus.ts`
- `../core/twilioSignature.ts`
- `../core/sms.ts`
- Any future internal module outside `src/gtm/` that would couple GTM to the current Twilio/SMS production path

## File Ownership

| File | Responsibility |
| --- | --- |
| `index.ts` | Public API surface for external callers |
| `types.ts` | Shared GTM types only |
| `service.ts` | Orchestrates store, engine, classifier, and email client |
| `sequence-engine.ts` | Pure outbound sequence decision logic |
| `lead-store.ts` | Durable state persistence seam |
| `email-client.ts` | Outbound email provider seam |
| `prompts.ts` | Plain-text GTM copy and template rendering |
| `handler.ts` | Isolated HTTP routes for GTM operations |
| `reply-classifier.ts` | Inbound reply classification seam |
| `handler.test.ts` | Unit tests and integration TODO coverage |

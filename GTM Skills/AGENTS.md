# GTM Module — Agent & Contributor Rules

## Scope

This module handles **outbound GTM (Go-To-Market) workflows only**.
Its initial use case is **missed-call recovery / lost job re-engagement** via
plain-text email sequences.

---

## Hard Constraints

| Rule | Detail |
|------|--------|
| **No Twilio / SMS changes** | Do not touch Twilio webhooks, SMS handlers, signature validation, or any core production path unless explicitly requested in a separate task |
| **Plain-text email only** | No HTML email templates. All outbound messages are plain text |
| **No auto-send by default** | Sequences must be explicitly triggered; no background cron jobs that auto-send without a deliberate call |
| **Sequence stops on reply** | Any inbound reply from a lead must halt the sequence immediately |
| **Max 3 touches per lead** | Hard ceiling. No lead receives more than 3 outbound emails in a sequence |
| **All lead state persisted** | LeadStatus and sequence progress must be written to durable storage before any email is dispatched |
| **Tests required** | Any new behavior added to this module requires a corresponding test |

---

## Module Positioning

- **Primary trigger:** missed call → no booked job within 24 h
- **Goal:** recover the lead via a short, warm email sequence
- **Tone:** conversational, human, not salesy

---

## File Ownership

| File | Responsibility |
|------|---------------|
| `index.ts` | Public API surface for the module |
| `types.ts` | Shared interfaces and enums |
| `service.ts` | Orchestration layer |
| `sequence-engine.ts` | Step scheduling and stop logic |
| `lead-store.ts` | Persistence adapter |
| `email-client.ts` | Sending adapter |
| `prompts.ts` | Email copy and prompt templates |
| `handler.ts` | HTTP handler (optional, only if an endpoint is needed) |
| `reply-classifier.ts` | Classifies inbound replies (optional) |

---

## Do Not

- Do not import from `../twilio/`, `../sms/`, or any core production webhook path
- Do not add HTML email libraries
- Do not store secrets in this module; use environment variables via config
- Do not create a scheduler or cron job without explicit product sign-off

# GTM Module — Agent & Contributor Rules

## Scope

This module handles **outbound GTM (Go-To-Market) workflows only**.
Its initial use case is **missed-call recovery / lost job re-engagement** via
plain-text email sequences.

The GTM backend is the **execution engine**.
Any agent layer added under `src/gtm/agents` is a **decision layer only**.

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

## Agent Layer Rules

These rules apply to all files under `src/gtm/agents`.

| Rule | Detail |
|------|--------|
| **Decision-only** | Agents may review leads, discover candidate leads, write outreach copy, and interpret replies only |
| **No direct sends** | Agents must not send emails directly |
| **No direct persistence** | Agents must not write to D1 or any database directly |
| **No sequence mutation** | Agents must not advance sequence state or modify touch counts |
| **No stop override** | Agents must not override the deterministic stop-on-reply rule |
| **Structured outputs only** | Agent outputs must be schema-validated before backend use |
| **No live service control** | Agents must not call Twilio or mutate live GTM logic directly |
| **Side-effect free imports** | Agent modules must not perform network calls, env access, or service initialization at import time |
| **Runner is invocation-only** | `src/gtm/agents/runner.ts` must not contain business logic, send logic, or direct state mutation |

---

## Module Positioning

- **Primary trigger:** missed call → no booked job within 24 h
- **Goal:** recover the lead via a short, warm email sequence
- **Tone:** conversational, human, not salesy
- **Architecture:** deterministic backend + schema-validated decision layer

---

## Architecture Boundary

### GTM backend owns:
- lead state
- touchpoint persistence
- sequence scheduling
- send execution
- stop-on-reply
- auditability / tests

### Agent layer owns:
- lead discovery
- lead review
- outreach writing
- reply interpretation

### Manager / sub-agent rule
If a manager agent is used, it must orchestrate sub-agents as helpers and return a final validated result.
The manager must not bypass backend rules.

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
| `reply-classifier.ts` | Minimal deterministic reply safety / classification seam |
| `agents/schemas.ts` | Zod schemas for all agent outputs |
| `agents/lead-discovery.ts` | Candidate lead discovery only |
| `agents/lead-review.ts` | Lead approval / scoring / outreach angle selection |
| `agents/outreach-writer.ts` | Structured plain-text outreach generation |
| `agents/reply-interpreter.ts` | Post-stop reply interpretation for operator guidance |
| `agents/manager.ts` | Agent orchestration / routing |
| `agents/runner.ts` | Agent invocation only; no business logic |
| `agents/README.md` | Agent-layer contracts, integration points, and wiring notes |

---

## Do Not

- Do not import from `../twilio/`, `../sms/`, or any core production webhook path
- Do not add HTML email libraries
- Do not store secrets in this module; use environment variables via config
- Do not create a scheduler or cron job without explicit product sign-off
- Do not allow agents to bypass backend persistence or sequence rules
- Do not move deterministic backend logic into `src/gtm/agents`

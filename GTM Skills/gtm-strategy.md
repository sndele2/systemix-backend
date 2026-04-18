# GTM Module — Strategy, Critique & Implementation Guide

## Executive Summary

This document captures the Go-To-Market (GTM) strategy for outbound missed-call recovery, a critique of the original plan, improvements made during implementation, and a reference for the scaffold that was built.

---

## Original Plan — Critique

### Strengths

The original prompt was well-structured and showed genuine engineering discipline. Key positives:

- **Isolation-first thinking.** Requiring a dedicated `gtm/` folder and explicitly forbidding contamination of Twilio/SMS paths is the right instinct. GTM logic does not belong scattered across production webhook handlers.
- **Constraint clarity.** Hard rules (max 3 touches, stop on reply, plain-text only, no auto-send, persist before send) were explicit and sensible. These are exactly the constraints needed to ship safely.
- **Lean scope.** The prompt explicitly deferred full business logic. This is correct — building the scaffold first reduces the cost of changing direction later.
- **Module boundary via AGENTS.md.** Using an agents file to document ownership and constraints is a strong convention. It survives team turnover better than comments buried in code.

### Weaknesses & Gaps

| Gap | Risk | Fix Applied |
|-----|------|-------------|
| No guidance on how the sequence is *triggered* externally | Could lead to ad-hoc wiring into Twilio handlers (violating the constraint) | Added `handler.ts` with a dedicated `/gtm/` route surface |
| `handler.ts` listed as optional with no justification | Without a defined HTTP surface, callers will improvise | Included `handler.ts` with clear doc on why it exists and what routes to register |
| Reply classification listed as optional | Misclassifying an opt-out as "unknown" is a compliance risk | Included `reply-classifier.ts` with explicit rationale |
| No test scaffold in original spec | Tests were required by AGENTS.md but no structure was given | Added `handler.test.ts` with working unit tests for SequenceEngine and prompts |
| Email provider not specified | Teams often add provider SDKs ad-hoc later, polluting the module | `email-client.ts` is the single seam — swap the provider inside it, nothing else changes |
| `dryRun` flag not called out in types | Easy to forget; live sends can happen accidentally in staging | Added explicit `dryRun: boolean` to `GTMConfig` with a safe default of `true` |
| Sequence delay values not specified | Different people will invent different delays in different places | Centralized in `sequence-engine.ts` as a single `DEFAULT_SEQUENCE` array |

---

## Improvements Made

### 1. dryRun-Safe by Default

`GTMConfig.dryRun` defaults to `true`. The `EmailClient` will log but not send unless explicitly set to `false`. This prevents accidental live sends in development or staging.

### 2. Persist-Before-Send Invariant

The docstring on `LeadStore` and `GTMService.advanceSequence` explicitly states: **state must be persisted before any email is dispatched.** If the store write fails, the send must not proceed. This prevents double-sends on retry.

### 3. Engine is Pure and Testable

`SequenceEngine.next()` takes touchesSent and status as arguments and returns a decision object. It has no I/O, no side effects, and no dependencies on the store or email client. This makes it trivially unit-testable (see `handler.test.ts`).

### 4. Single Seam for Email Providers

`email-client.ts` is the only file that imports a provider SDK. When you decide between Resend, Postmark, Nodemailer, or SES, the change is contained to one file.

### 5. Template Registry Pattern

`prompts.ts` uses a `TEMPLATES` map keyed by `TEMPLATE_KEYS`. Adding a new touch requires: (1) add a key constant, (2) write a function, (3) register it. No switch statements, no scattered conditionals.

### 6. Handler Justification Documented

`handler.ts` explains explicitly why it exists: external triggers need an HTTP surface, and without one, callers will wire directly into Twilio or build ad-hoc routes. Its existence prevents a worse anti-pattern.

---

## Folder Structure Created

```
backend/
└── gtm/
    ├── AGENTS.md             ← Module governance rules
    ├── index.ts              ← Public API surface (import from here)
    ├── types.ts              ← Shared interfaces and enums
    ├── service.ts            ← Orchestration layer
    ├── sequence-engine.ts    ← Step scheduling and stop logic
    ├── lead-store.ts         ← Persistence adapter
    ├── email-client.ts       ← Sending adapter
    ├── prompts.ts            ← Email copy and template system
    ├── handler.ts            ← HTTP handler (optional routes)
    ├── reply-classifier.ts   ← Inbound reply classification
    └── handler.test.ts       ← Test scaffold
```

---

## File Reference

### AGENTS.md
Module governance. Defines scope, hard constraints, file ownership, and what is forbidden. This is the first thing any contributor should read.

### index.ts
The module boundary. External callers import only from here. Re-exports types from `types.ts` and `GTMService` from `service.ts`.

### types.ts
All shared interfaces and enums: `Lead`, `LeadStatus`, `EmailStage`, `ReplyClassification`, `GTMConfig`. No business logic, no imports from other GTM files.

### service.ts
Orchestrator. `GTMService` is the single entry point. It coordinates the store, engine, and email client. Methods: `startSequence`, `advanceSequence`, `stopSequence`, `getStatus`. Stubbed with clear TODOs.

### sequence-engine.ts
Pure logic. Takes touchesSent + status, returns a decision (send or stop). Owns the sequence definition (delays, template keys). Enforces the 3-touch ceiling. Fully unit-testable with no mocking.

### lead-store.ts
Persistence adapter. `LeadStore` exposes `create`, `findById`, `update`, `findActive`. Swap the backing database inside this file without touching anything else.

### email-client.ts
Sending adapter. `EmailClient.send()` dispatches plain-text email or logs it in dry-run mode. Single seam for the email provider SDK.

### prompts.ts
Email copy. Template registry keyed by `TEMPLATE_KEYS`. Three touch templates (warm, follow-up, close). `renderTemplate(key, ctx)` is the only public function.

### handler.ts
HTTP surface. `GTMHandler` provides `startSequence`, `stopSequence`, and `handleInboundReply` handlers. Must be registered under `/gtm/` — not inside the Twilio router.

### reply-classifier.ts
Inbound classification. `classifyReply(rawText)` returns a `ReplyClassification` with intent and confidence. Stub returns 'unknown' until implemented.

### handler.test.ts
Test scaffold. Working unit tests for `SequenceEngine` and `renderTemplate`. Pending integration tests for `GTMService` marked with `it.todo`.

---

## Conflicts with Existing Repository Conventions

| Check | Status |
|-------|--------|
| TypeScript | ✅ All files are .ts |
| Kebab-case filenames | ✅ All files use kebab-case |
| Module boundaries | ✅ External callers use index.ts only |
| No new dependencies | ✅ No new packages added; email SDK is deferred |
| No scattered logic | ✅ All GTM logic lives in gtm/ |
| Twilio/SMS paths unchanged | ✅ No imports from or modifications to Twilio/SMS modules |

---

## Production Safety Confirmation

> **No core production Twilio paths were changed.**
> 
> No files outside `gtm/` were created, modified, or imported into. The Twilio webhook handler, SMS dispatch, and signature validation logic are completely untouched. The GTM module is additive and isolated.

---

## Sequence Rules Summary

| Rule | Value |
|------|-------|
| Max touches per lead | 3 |
| Touch 1 delay | 1 hour after trigger |
| Touch 2 delay | 24 hours after touch 1 |
| Touch 3 delay | 72 hours after touch 2 |
| Stop condition | Any reply from lead |
| Auto-send default | Off (dryRun: true) |
| Email format | Plain text only |
| State persistence | Before every send |

---

## Next Steps

1. **Choose and wire a persistence backend** in `lead-store.ts` (Postgres recommended for durability)
2. **Choose an email provider** and implement `EmailClient.send()` in `email-client.ts`
3. **Choose a scheduler** to handle delayHours (e.g. BullMQ, pg-boss, or a simple setTimeout for low volume)
4. **Implement `GTMService` methods** in `service.ts` — all TODOs are clearly marked
5. **Wire `GTMHandler`** routes under `/gtm/` in the router (separate from Twilio routes)
6. **Refine email copy** in `prompts.ts` with product/marketing input
7. **Implement `classifyReply`** starting with keyword matching for opt-out phrases
8. **Complete integration tests** in `handler.test.ts`

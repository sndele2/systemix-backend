# `src/gtm/agents` — Agent Layer README

## Purpose

This folder contains the **decision layer** for the GTM module.

It exists to support the deterministic GTM backend by adding bounded model judgment for:
- lead discovery
- lead review
- outreach generation
- reply interpretation

This folder is **not** the GTM execution engine.

---

## Core Rule

> The GTM backend executes.  
> The agent layer decides.

That means:
- backend code owns sequence timing, persistence, and sending
- agent code owns bounded analysis and structured outputs

---

## Files

| File | Responsibility |
|------|---------------|
| `schemas.ts` | Zod schemas for all agent inputs/outputs |
| `lead-discovery.ts` | Finds and normalizes candidate business leads |
| `lead-review.ts` | Approves/rejects/scorers candidate leads and picks outreach angle |
| `outreach-writer.ts` | Generates structured plain-text outreach |
| `reply-interpreter.ts` | Interprets inbound replies after deterministic stop-on-reply |
| `manager.ts` | Routes tasks to the correct sub-agent |
| `runner.ts` | Invokes agents and parses final results only |

---

## Architectural Constraints

### Agents may:
- discover candidate leads
- score / approve leads
- choose an outreach angle
- generate plain-text outreach content
- classify replies
- recommend manual next actions

### Agents may not:
- send emails directly
- write to D1 directly
- advance lead sequence state
- override stop-on-reply
- call Twilio or mutate live GTM execution logic
- access live tools automatically on import

### Runner may not:
- contain business logic
- contain state mutation
- contain direct service orchestration
- bypass schema validation

---

## Integration Points With Existing GTM Backend

These are comments / stubs only until explicitly wired.

### 1. Lead review
Hook at the orchestration layer before lead creation or activation.

### 2. Outreach writer
Hook before static prompt/template selection for outbound touches.

### 3. Reply interpreter
Hook after deterministic reply-stop logic has already executed.

### 4. Lead discovery
Mount as a separate ingestion path or internal/dev-only route. Do not embed it into existing send flows.

---

## Wiring Live Tools Later

Live discovery/search/fetch tools should be injected at runtime via `runner.ts` or a higher orchestration layer.

### TODO guidance
- keep discovery/search tools external to agent definitions
- use stubs first
- do not initialize live services inside agent modules
- validate every agent output before passing it to backend execution logic

---

## Output Discipline

Every agent must return structured JSON that matches a Zod schema in `schemas.ts`.

Suggested categories:
- lead discovery output
- lead review output
- outreach writer output
- reply interpreter output
- manager output

No loose prose should flow directly into GTM backend logic.

---

## Testing Expectation

Any new behavior added in this folder should have:
- schema coverage
- unit tests where applicable
- integration notes showing how the backend will consume the result

---

## Change Control

If this folder changes, review:
- `src/gtm/AGENTS.md`
- `src/gtm/service.ts`
- `src/gtm/prompts.ts`
- `src/gtm/reply-classifier.ts`

The goal is to prevent accidental overlap between:
- deterministic execution
- agentic decision-making

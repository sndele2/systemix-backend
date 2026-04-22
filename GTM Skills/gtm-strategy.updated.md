# GTM Module — Strategy, Critique & Implementation Guide

## Executive Summary

This document captures the GTM strategy for outbound missed-call recovery and the updated architecture for an **agent-assisted, deterministic GTM system**.

The key design principle is:

> **`src/gtm` remains the execution engine.**
> **`src/gtm/agents` is a decision layer only.**

The agent layer exists to improve:
- lead discovery
- lead review
- outreach quality
- reply interpretation

It does **not** replace:
- lead persistence
- touchpoint sequencing
- send execution
- reply-stop behavior

---

## Updated Architecture

### Deterministic Backend Responsibilities (`src/gtm`)
The backend remains responsible for:
- lead state
- touchpoint persistence
- sequence timing
- send execution
- reply sync
- stop-on-reply
- auditing and tests

### Agent Layer Responsibilities (`src/gtm/agents`)
The agent layer is responsible for:
- discovering candidate leads
- reviewing / scoring candidate leads
- generating constrained plain-text outreach
- interpreting inbound replies after deterministic stop-on-reply has already fired

### Why this split exists
This keeps high-risk workflow control in code while using model judgment only where rigidity reduces performance.

---

## Agent Topology

### Recommended structure
- **Manager agent**
- **Lead discovery sub-agent**
- **Lead review sub-agent**
- **Outreach writer sub-agent**
- **Reply interpreter sub-agent**

### Why not let all agents act independently?
Because the GTM system already has durable sequencing and state logic. Multiple peer agents would increase ambiguity and risk.
The manager/sub-agent model preserves one clear decision boundary.

---

## Agent Contracts

### Lead Discovery
Purpose:
- find candidate businesses from constrained inputs/tools
- normalize outputs into a known schema

Must not:
- score leads
- approve/reject leads
- choose outreach strategy
- send anything

### Lead Review
Purpose:
- approve/reject candidate leads
- score quality
- choose outreach angle

Must not:
- mutate lead state directly
- dispatch emails
- control sequence timing

### Outreach Writer
Purpose:
- generate plain-text subject/body/variant outputs for outbound touches

Must:
- remain concise
- avoid AI buzzwords
- stay grounded in provided lead context

Must not:
- decide send timing
- invent unsupported claims
- send anything

### Reply Interpreter
Purpose:
- classify inbound replies
- recommend manual next action

Must not:
- override stop-on-reply
- draft outbound replies by default
- resume or mutate sequence state

---

## Integration Points

The intended hook points are:

1. **Lead review** before lead creation / activation at the orchestration layer
2. **Outreach writer** before prompt/template generation for outbound touches
3. **Reply interpreter** after deterministic reply-stop logic
4. **Lead discovery** as a separate ingestion path, not embedded into existing send flows

These integrations must remain surgical and must not broaden GTM scope.

---

## Relationship to Existing Files

### `reply-classifier.ts`
This remains the minimal deterministic classification / safety seam if needed.

### `agents/reply-interpreter.ts`
This is a richer, decision-only interpretation layer used **after** the hard stop rule has already been enforced.

These files should not be conflated.

---

## Sequence Rules Summary

| Rule | Value |
|------|-------|
| Max touches per lead | 3 |
| Touch 1 delay | 1 hour after trigger |
| Touch 2 delay | 24 hours after touch 1 |
| Touch 3 delay | 72 hours after touch 2 |
| Stop condition | Any reply from lead |
| Auto-send default | Off / dry-run by default |
| Email format | Plain text only |
| State persistence | Before every send |

---

## Production Safety

- No Twilio/SMS production paths should be changed by GTM agent work
- No live sending should be enabled as part of agent scaffolding
- No agent may directly mutate database state
- No agent may directly dispatch email
- All agent outputs must be schema-validated before backend use

---

## Recommended Build Order

1. Add `src/gtm/agents/schemas.ts`
2. Add outreach writer agent
3. Add reply interpreter agent
4. Add lead review agent
5. Add lead discovery agent
6. Add manager orchestration
7. Wire integration points surgically into `src/gtm`

This order reduces risk and gets the highest-value behavior working first.

---

## Documentation Rule

Whenever GTM agent behavior changes, update:
- `AGENTS.md`
- `src/gtm/agents/README.md`
- any integration notes that affect `service.ts`, `prompts.ts`, `reply-classifier.ts`, or `handler.ts`

The doctrine must stay ahead of implementation, not lag behind it.

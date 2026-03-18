---
name: dev-change-executor
version: 1.0.0
description: Execute development and staging changes safely within Systemix while preserving architectural constraints, testability, and promotion readiness.
---

## Purpose

Use this skill when implementing, modifying, or refactoring code intended for development or staging environments.

This skill is responsible for building and changing code, not for approving production release safety. It should optimize for fast iteration without violating Systemix architecture.

It is the default execution skill for:
- feature development
- controlled refactors
- instrumentation and diagnostics
- schema evolution in development
- AI prompt / classification iteration
- internal tooling changes
- staging validation changes

## System Context

Systemix is an edge-native platform built on Cloudflare Workers with:
- latency-sensitive webhook handlers
- D1 as the primary relational store
- multi-tenant isolation enforced by business_number
- AI classification requiring strict JSON outputs
- HubSpot synchronization treated as asynchronous eventual consistency

Development changes must preserve those invariants even in non-production environments.

## Primary Responsibilities

1. Implement changes in development/staging safely.
2. Respect all applicable AGENTS.md files before editing.
3. Preserve interface and contract stability unless a change explicitly requires contract modification.
4. Make changes in a way that remains promotable to production.
5. Keep diffs minimal, understandable, and testable.

## Required Pre-Edit Procedure

Before making any changes:

1. Read the nearest relevant AGENTS.md files.
2. Identify:
   - runtime constraints
   - data integrity constraints
   - API/webhook contracts
   - AI output schema constraints
   - integration boundaries
3. Produce a brief implementation plan containing:
   - files to edit
   - why each file needs to change
   - risk areas
   - validation steps

Do not begin editing until the intended file set is clear.

## Execution Rules

### 1. Change Scope
- Edit only files required for the requested development task.
- Avoid opportunistic refactors unless they are necessary for correctness or maintainability.
- Do not mix unrelated cleanup with feature work.

### 2. Runtime Safety
For Worker code:
- do not introduce blocking I/O
- do not introduce unsupported Node.js APIs
- do not move high-latency work into synchronous request paths
- maintain ctx.waitUntil(...) patterns where required

### 3. Data Safety
For D1/database changes:
- preserve tenant scoping with business_number
- preserve or improve UPSERT correctness
- avoid schema edits without migration awareness
- prefer reversible or forward-compatible changes in development

### 4. AI Contract Safety
For AI/classification changes:
- preserve strict JSON-only outputs
- preserve or explicitly update parsing assumptions
- never introduce unstructured LLM output into machine-read paths
- minimize prompt bloat and unnecessary tokens

### 5. Instrumentation / Diagnostics
Development-only logging or diagnostics are allowed if:
- they do not materially increase hot-path latency
- they do not expose secrets or sensitive identifiers
- they are clearly scoped
- they are removable or intentionally retained with justification

### 6. Testing
For every meaningful code change:
- update or add tests where applicable
- validate relevant behavior locally or in staging
- document which checks were run

## Allowed Behaviors

This skill may:
- implement features
- refactor locally within a bounded scope
- add safe development diagnostics
- adjust prompt templates
- add tests
- prepare migrations
- improve code clarity when directly relevant

This skill may not:
- declare production readiness
- approve release safety unilaterally
- bypass architectural constraints for convenience
- silently change public or internal contracts without calling it out
- make speculative production-risk changes

## Required Output Format

When completing a task, respond with:

### A. Summary
- what changed
- why it changed

### B. Files Changed
For each file:
- path
- role of the change

### C. Constraint Check
Explicitly confirm:
- Worker/runtime constraints preserved
- data isolation preserved
- AI output contract preserved or intentionally updated
- async boundaries preserved

### D. Validation
List:
- tests run
- manual checks performed
- remaining risks

## Decision Heuristics

Choose minimal implementation when:
- multiple valid approaches exist
- the more complex design is not required for the current task
- the request is development-focused and not architecture-redesign-focused

Escalate risk explicitly when:
- a schema change affects provisioning or tenant isolation
- a webhook contract changes
- AI output shape changes
- a change may affect latency in the synchronous path
- an integration assumption is modified

## Success Criteria

A successful execution under this skill means:
- the requested dev/staging change is implemented correctly
- architectural invariants are preserved
- the diff is focused and promotable
- tests and validations are identified or executed
- no unnecessary production risk is introduced

## Failure Conditions

This skill has failed if it:
- introduces blocking behavior in edge handlers
- breaks multi-tenant isolation
- weakens JSON AI output guarantees
- adds unrelated changes
- changes behavior without documenting contract impact
- performs production approval logic instead of development execution

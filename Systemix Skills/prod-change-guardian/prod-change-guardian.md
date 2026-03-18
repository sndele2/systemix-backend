---
name: prod-change-guardian
description: Review, constrain, and protect production-facing Systemix changes by enforcing operational safety, backward compatibility, rollback readiness, and latency discipline.
---

## Purpose

Use this skill when a task affects production behavior, live reliability, or release-critical paths.

This skill is a production safety gate, not a broad implementation skill.

It is intended for:
- production hotfix review
- release-sensitive code changes
- webhook path review
- schema change safety review
- AI contract stability review
- operational readiness checks
- rollback and observability verification

## System Context

Systemix production depends on:
- Cloudflare Workers with tight latency expectations
- immediate webhook acknowledgment
- D1-backed multi-tenant isolation
- deterministic AI classification outputs
- async-only external CRM synchronization
- strict separation between hot path and high-latency integrations

Any production change must be evaluated for:
- latency regression risk
- data integrity risk
- contract breakage
- rollback feasibility
- observability sufficiency

## Primary Responsibilities

1. Protect live production behavior.
2. Review whether a proposed change is safe to release.
3. Block unsafe changes or require mitigations.
4. Enforce minimality for production diffs.
5. Ensure rollback, compatibility, and monitoring are considered.

## Review Model

This skill does not assume that working in development means safe for production.

Every production-touching change must be evaluated across five dimensions:

1. Runtime Safety
2. Data Integrity
3. Contract Compatibility
4. Operational Recoverability
5. Observability

## Required Review Procedure

Before approving a change, perform the following:

### 1. Identify Production Surface Area
Classify the change as affecting one or more of:
- webhook request path
- database schema or queries
- AI classification pipeline
- HubSpot sync behavior
- environment/config bindings
- tenant scoping
- release/deployment mechanics

### 2. Determine Blast Radius
Assess:
- which endpoints are touched
- whether tenant boundaries are affected
- whether external integrations are affected
- whether synchronous latency can increase
- whether retries, duplicates, or dropped events are possible

### 3. Evaluate Backward Compatibility
Check whether the change preserves:
- request/response contracts
- message parsing assumptions
- DB compatibility with existing rows
- AI JSON schema assumptions
- integration field mappings

### 4. Evaluate Rollback Feasibility
Confirm:
- the change can be reverted cleanly
- rollback does not depend on manual state surgery
- schema changes are backward-compatible or explicitly guarded
- production recovery path is documented

### 5. Evaluate Observability
Confirm:
- failures are loggable/traceable
- critical error paths remain visible
- key behavior changes can be monitored

## Enforcement Rules

### 1. Minimal Diff Rule
Production changes should be as small as reasonably possible.
- no speculative cleanup
- no opportunistic refactors
- no stylistic churn
- no unrelated file edits

### 2. Hot Path Protection Rule
For webhook or synchronous request path changes:
- no added blocking network calls
- no added heavy computation
- no moving async work into sync flow
- preserve immediate acknowledgment behavior

### 3. Compatibility Rule
Do not approve:
- breaking API shape changes without explicit migration path
- AI schema changes without downstream parser updates
- DB changes that can strand existing rows or violate uniqueness assumptions

### 4. Integration Containment Rule
External service behavior must remain isolated.
Do not approve changes that:
- make HubSpot required for successful lead handling
- make OpenAI success a prerequisite for webhook acknowledgment
- couple CRM sync to hot-path execution

### 5. Rollback Rule
Do not approve production changes unless rollback is:
- possible
- understandable
- low-risk

## Output Classification

This skill must return one of the following decisions:
- APPROVE
- APPROVE_WITH_CONDITIONS
- BLOCK

### APPROVE
Use only when:
- production risk is low
- compatibility is preserved
- rollback is straightforward
- observability is sufficient

### APPROVE_WITH_CONDITIONS
Use when:
- the change is directionally acceptable
- but specific mitigations are required before release

Examples:
- add monitoring
- split rollout
- add migration guard
- add tests
- reduce diff scope

### BLOCK
Use when:
- latency risk is unacceptable
- rollback is unclear
- compatibility is broken
- tenant safety is threatened
- production blast radius is too high for the current implementation

## Required Output Format

### A. Production Surface
List the systems affected.

### B. Risk Assessment
For each category:
- runtime
- data
- contract
- integration
- rollback
- observability

Give:
- risk level: LOW | MEDIUM | HIGH
- short technical rationale

### C. Decision
Return exactly one:
- APPROVE
- APPROVE_WITH_CONDITIONS
- BLOCK

### D. Conditions or Mitigations
If not fully approved, list exact required changes.

### E. Rollback Notes
State how the change would be reversed safely.

## What This Skill May Do

This skill may:
- review a proposed change
- constrain a production diff
- require a smaller implementation
- require additional tests or monitoring
- require rollback planning

This skill may not:
- perform broad feature development
- redesign large architecture surfaces casually
- assume dev success equals production readiness
- approve changes without explicit risk review

## Success Criteria

A successful use of this skill means:
- production risk is clearly understood
- unsafe changes are blocked early
- safe changes are constrained appropriately
- rollback and observability are explicit
- live reliability is protected

## Failure Conditions

This skill fails if it:
- approves high-blast-radius changes casually
- ignores rollback complexity
- overlooks latency regressions
- allows contract-breaking changes without safeguards
- treats production like a generic coding environment

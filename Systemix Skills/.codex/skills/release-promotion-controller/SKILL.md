---
name: release-promotion-controller
version: 1.0.0
description: Govern promotion between development and production by evaluating readiness, compatibility, environment drift, rollback viability, and release conditions for Systemix.
---

## Purpose

Use this skill when deciding whether a change should move:
- from development/staging to production
- from a production hotfix back into development
- between environment branches where parity matters

This skill is a promotion gate and release controller.

It is not a general implementation skill and not a free-form deployment agent.

Its job is to:
- compare environments
- validate readiness
- detect drift
- enforce release conditions
- output a promotion decision

## Core Principle

Promotion is not just code exists in dev.

Promotion means:

implemented
-> validated
-> compatible
-> observable
-> recoverable
-> promotable

This skill must enforce that sequence.

## Promotion Scenarios

### Scenario A - Dev/Staging -> Production
Use when promoting completed work to live production.

### Scenario B - Production Hotfix -> Development
Use when syncing emergency or direct production fixes back into development to restore branch and environment parity.

### Scenario C - Environment Drift Review
Use when determining whether dev and prod have diverged in ways that threaten reliable release flow.

## Required Inputs

When possible, gather or infer:
- source environment/branch
- target environment/branch
- changed files
- relevant systems touched
- test results
- migration status
- contract changes
- config/env binding changes
- rollback availability

If any of these are missing, explicitly call that out.

## Evaluation Procedure

### 1. Identify Promotion Direction
Determine whether the task is:
- dev -> prod
- prod -> dev
- parity/drift analysis

The review standard changes based on direction.

### 2. Build Change Inventory
Enumerate:
- file set
- subsystem set
- contract changes
- config changes
- schema changes
- integration changes

Map the changes to:
- Workers/runtime
- DB/D1
- AI pipeline
- CRM/integrations
- deployment/config

### 3. Check Validation Completeness
For dev -> prod promotions, verify:
- relevant tests were run
- local/staging validation exists
- critical contracts were checked
- production-sensitive paths were reviewed
- any migrations are understood

### 4. Check Promotion Safety
Evaluate:
- backward compatibility
- rollback safety
- observability
- environment-specific drift
- dependency on secrets/bindings/config
- hot-path latency risk

### 5. Check Parity / Drift
For prod -> dev or parity analysis:
- confirm hotfixes are backported cleanly
- identify branch drift
- flag missing config synchronization
- identify behavior mismatch risks between environments

## Decision Output

This skill must return exactly one of:
- APPROVE
- APPROVE_WITH_CONDITIONS
- BLOCK

## Decision Criteria

### APPROVE
Use when:
- validation is sufficient
- compatibility is preserved
- rollout risk is understood and acceptable
- rollback path exists
- no unresolved drift threatens the promotion

### APPROVE_WITH_CONDITIONS
Use when:
- promotion is feasible
- but explicit release conditions must be met first

Examples:
- run missing tests
- add rollback notes
- sync env bindings
- apply migration guard
- backport a hotfix before release
- split release into smaller stages

### BLOCK
Use when:
- the promotion is under-validated
- environment drift is unresolved
- schema or contract changes are unsafe
- rollback is unclear
- production risk is too high

## Required Output Format

### A. Promotion Direction
State:
- source
- target
- scenario type

### B. Change Inventory
List:
- major files / systems touched
- critical contracts affected
- config/env assumptions

### C. Readiness Assessment
Cover:
- tests
- compatibility
- rollback
- observability
- drift
- operational risk

### D. Decision
Return exactly one:
- APPROVE
- APPROVE_WITH_CONDITIONS
- BLOCK

### E. Required Conditions
If conditional or blocked, list specific actions required to proceed.

### F. Promotion Notes
State:
- what makes this release safe or unsafe
- what must be watched after promotion
- whether reverse-sync is required

## Enforcement Rules

1. Do not treat "works in dev" as production readiness.
2. Do not allow environment promotion without explicit validation.
3. Do not ignore config drift or secret/binding mismatches.
4. Do not approve promotions that rely on implicit tribal knowledge.
5. Do not assume schema changes are safe without compatibility analysis.
6. For prod hotfixes, ensure parity restoration back into development is addressed.

## What This Skill May Do

This skill may:
- compare source and target readiness
- gate releases
- identify promotion blockers
- define release conditions
- require parity restoration
- require validation before promotion

This skill may not:
- perform broad feature implementation as its primary task
- auto-deploy by default
- approve releases without explicit reasoning
- ignore unresolved drift between environments

## Success Criteria

A successful use of this skill means:
- promotion decisions are explicit and defensible
- release risk is made visible before deployment
- dev/prod drift is reduced
- rollback and monitoring expectations are clear
- release movement becomes governed rather than improvised

## Failure Conditions

This skill fails if it:
- allows promotion without sufficient validation
- overlooks drift between environments
- ignores missing rollback strategy
- approves risky contract or schema movement casually
- acts like a deployment bot instead of a release controller

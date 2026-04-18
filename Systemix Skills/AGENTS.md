---
name: Systemix Global Rules
description: Repository-wide guidelines for editing and building Systemix.
color: "#006400"
---

# Systemix — Global Agent Policy

This file is the root policy for all Codex-assisted work on Systemix. Read it fully before making any change. Then consult the relevant submodule `AGENTS.md` for local rules.

**Also load at the start of every session:**
- `ARCHITECTURE.md` — system topology, data flow, layer boundaries
- `CONVENTIONS.md` — code style, naming, patterns
- `SECURITY.md` — threat model, mandatory checks, forbidden patterns

---

## System at a Glance

Systemix is a multi-tenant SaaS platform running on Cloudflare Workers (V8 isolates) with:
- **D1** as the primary database, tenant-isolated by `business_number`
- **AI orchestration** layer for semantic intent classification (strict JSON output)
- **Webhook handlers** for Stripe, Twilio, and internal onboarding
- **Async CRM sync** to HubSpot and other external systems
- **Workers** for background processing and queue consumption

---

## Architectural Invariants — Never Violate These

These are non-negotiable. Any PR that breaks one must not be merged.

### 1. Edge Performance
- No synchronous network or DB calls inside `fetch()` handlers
- No heavy npm dependencies — V8 isolates have strict CPU/memory budgets
- All post-response work goes through `ctx.waitUntil()`
- Target: **< 10ms median** for edge request handlers

### 2. Multi-Tenant Data Isolation
- Every DB query **must** include `business_number` in the WHERE clause or primary key
- Never derive `business_number` from user input alone — always validate against the authenticated session
- Schema changes must preserve the `business_number` unique constraint and upsert semantics
- Cross-tenant queries are forbidden unless explicitly operating as a platform admin

### 3. AI Output Contract
- All LLM responses must be **machine-parseable JSON only** — no prose, no markdown, no stray tokens
- Strip Twilio/Stripe metadata before sending to inference to reduce token cost
- Validate and type-check AI output before acting on it — never trust raw LLM output

### 4. Webhook Safety
- Validate **Stripe signatures** (`stripe-signature` header) before any processing
- Validate **Twilio signatures** (Authorization header) before any processing
- Return **HTTP 200 immediately** — offload everything else to `ctx.waitUntil()`
- Never perform DB writes or external calls in the synchronous webhook path

### 5. Secret Hygiene
- All secrets via environment variables — never hardcoded, never logged
- Internal endpoints require Authorization headers — no unauthenticated internal routes
- See `SECURITY.md` for the full threat model

### 6. External Reliability
- HubSpot, OpenAI, and other external failures must **never** surface as errors to the webhook caller
- Implement retry with exponential backoff and dead-letter handling
- Design for eventual consistency — not strong consistency — with external CRMs

---

## Workflow — Follow This Every Time

1. **Read first:** Load `ARCHITECTURE.md`, `CONVENTIONS.md`, and `SECURITY.md`
2. **Locate:** Identify which submodule is affected (`ai/`, `db/`, `integrations/`, `workers/`) and read its local `AGENTS.md`
3. **Branch:** Work in a feature branch with conventional commit messages (`feat:`, `fix:`, `chore:`, `security:`)
4. **Test:** Run and update unit + integration tests; add tests for new behaviour and edge cases
5. **Security check:** Run through the `SECURITY.md` checklist before committing
6. **PR:** Open a pull request with a clear description; do not self-merge

---

## Success Criteria

- Median edge response time remains < 10ms
- Zero cross-tenant data leakage
- Zero hardcoded secrets
- All tests pass with new coverage added
- No production incidents from schema or code changes
- Security checklist cleared on every PR

# Systemix — Architecture Reference

This document describes the system topology, layer responsibilities, data flow, and boundaries that the agent must respect when making changes.

---

## System Topology

```
Inbound Requests
       │
       ▼
┌─────────────────────────────────────────┐
│         Cloudflare Workers (Edge)        │
│                                         │
│  ┌─────────┐  ┌─────────┐  ┌────────┐  │
│  │ Stripe  │  │ Twilio  │  │Onboard │  │  ← Webhook entry points
│  │ Handler │  │ Handler │  │Handler │  │
│  └────┬────┘  └────┬────┘  └───┬────┘  │
│       │            │           │        │
│       └────────────┼───────────┘        │
│                    │                    │
│             ┌──────▼──────┐             │
│             │ AI / Intent  │             │  ← Semantic classification
│             │ Orchestrator │             │
│             └──────┬───────┘            │
│                    │                    │
│        ┌───────────┼───────────┐        │
│        ▼           ▼           ▼        │
│   ┌─────────┐ ┌────────┐ ┌─────────┐   │
│   │ Workers │ │   DB   │ │Integrat.│   │  ← Async processing layer
│   │ (Queue) │ │  (D1)  │ │(HubSpot)│   │
│   └─────────┘ └────────┘ └─────────┘   │
└─────────────────────────────────────────┘
```

---

## Layer Responsibilities

### `workers/`
- Background job processing and queue consumers
- Long-running tasks offloaded from webhook handlers via `ctx.waitUntil()`
- Must be stateless and idempotent — assume any worker can be retried
- Never block — all I/O must be async
- **Do not** call other workers synchronously; use queues

### `db/`
- All D1 database access, schema definitions, and migration scripts
- Every query must include `business_number` in WHERE or as part of the primary key
- Upsert semantics are the default for tenant data — avoid blind INSERTs
- Migrations must be backward-compatible and safe to run in production without downtime
- **Do not** import `db/` directly from `workers/` webhook handlers — go through a service layer

### `ai/`
- Semantic intent classification using OpenAI or compatible LLM
- Input: stripped, sanitized message payload (never raw Twilio/Stripe body)
- Output: **strict JSON only** — validated with a schema before use
- Prompt templates live here — changes to prompts require regression tests
- Token usage must be monitored — strip all unnecessary metadata before inference

### `integrations/`
- External API clients: HubSpot, Stripe SDK, Twilio SDK, etc.
- All external calls use retry with exponential backoff
- Failures are logged and queued for retry — never thrown up to the webhook handler
- **Do not** put business logic here — integrations are thin clients only
- Credentials come from environment variables only

### `dev-change-executor/`
- Handles changes in the development environment
- Has broader permissions — can run migrations, seed data, reset state
- Never runs against production resources

### `prod-change-guardian/`
- Gate for all production changes
- Validates that changes are migration-safe, backward-compatible, and tested
- Must approve before `release-promotion-controller` runs

### `release-promotion-controller/`
- Manages promotion of changes from dev → staging → production
- Checks that `prod-change-guardian` has signed off
- Coordinates rollback if health checks fail post-deploy

---

## Data Flow

### Inbound Webhook (Stripe / Twilio)
```
1. Validate signature / auth header         ← MUST happen first, synchronously
2. Return HTTP 200                          ← MUST happen before any processing
3. ctx.waitUntil(processAsync(payload))     ← ALL work happens here
   ├── Strip metadata
   ├── ai/ → classify intent
   ├── db/ → read/write tenant data (scoped by business_number)
   ├── workers/ → enqueue follow-up jobs
   └── integrations/ → async CRM sync
```

### Tenant Data Access
```
Every query: WHERE business_number = :business_number
Never: SELECT * FROM table (without tenant scope)
Never: derive business_number from user-supplied input without session validation
```

### AI Classification
```
Raw payload
  → strip to minimal fields (message text, sender context only)
  → ai/orchestrator → OpenAI API
  → validate JSON response against schema
  → route to appropriate handler
```

---

## Layer Boundary Rules

| From → To | Allowed? | Notes |
|---|---|---|
| Worker handler → db/ direct | ❌ No | Go through service layer |
| Worker handler → integrations/ direct | ❌ No | Offload via queue |
| ai/ → db/ | ✅ Yes | Read-only context lookups only |
| workers/ → db/ | ✅ Yes | Full read/write via service layer |
| workers/ → integrations/ | ✅ Yes | All external calls live here |
| integrations/ → db/ | ❌ No | Integrations are stateless clients |
| Any layer → hardcoded secrets | ❌ Never | Use env vars |

---

## Environment Separation

| Environment | Executor | Guardian Required? |
|---|---|---|
| Development | `dev-change-executor` | No |
| Staging | `release-promotion-controller` | Yes |
| Production | `release-promotion-controller` | Yes — mandatory sign-off |

---

## Key Constraints Summary

- **Tenant isolation:** `business_number` in every query
- **Async-first:** No blocking I/O in fetch handlers
- **Webhook response:** HTTP 200 before processing, always
- **AI output:** JSON schema-validated before use
- **Secrets:** Environment variables only, never logged
- **External failures:** Isolated from core flow via queues and retry

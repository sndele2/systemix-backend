# Systemix — Claude Code Instructions

Read this file fully before every session. Then load the referenced docs below.

---

## Load These First

Before touching any code, read:
- Systemix Skills/ARCHITECTURE.md
- Systemix Skills/CONVENTIONS.md
- Systemix Skills/SECURITY.md
- Systemix Skills/AGENTS.md

Do not invent architecture, patterns, or conventions. Match what is already there.

---

## What Systemix Is

Systemix is a missed-call recovery system for local service businesses — plumbers, HVAC
companies, electricians, and similar high-intent inbound-call businesses.

Core product flow:
1. Customer calls a local service business
2. Business misses the call
3. Systemix detects the missed call via Twilio webhook
4. Systemix sends an immediate compliant SMS to the customer
5. Customer replies
6. Reply appears in the internal operator inbox
7. Business responds and recovers the lead before the customer calls a competitor

This is NOT an AI receptionist, chatbot, CRM, or automation platform.
The wedge is narrow and intentional. Never broaden it without explicit instruction.

---

## Codebase Map

Primary backend:
  ~/Desktop/Systemix/systemix-backend/cloudflare workers/api-main/api/

Key source locations:
  src/index.ts                  Worker entry point and routing
  src/core/                     sms.ts, db.ts, auth, logging, Twilio sig validation
  src/webhooks/                 twilioVoice.ts, twilioSms.ts, stripe.ts
  src/services/                 missedCallRecovery.ts, smsCompliance.ts
  src/internal-inbox/           Operator inbox handlers and providers
  src/gtm/                      GTM outbound system (SEPARATE from product recovery)
  migrations/                   24 D1 migrations, numbered sequentially
  wrangler.jsonc                Cloudflare Worker config

Deployed backend:   https://systemix-backend.sean-ndele.workers.dev
Frontend:           Lovable-built, systemixai.co
Frontend env var:   VITE_SYSTEMIX_API_BASE_URL
Backend CORS var:   ALLOWED_ORIGIN

---

## Critical Technical Constraints

Runtime is Cloudflare Workers (V8 isolate) — NOT Node.js.
- No fs, path, process, Buffer, or Node-only packages. Use Web APIs only.

Webhooks must return HTTP 200 immediately.
- All processing goes in ctx.waitUntil(). Never block the webhook response.

Every DB query must include business_number in WHERE or primary key.
- No unscoped queries. Verify live D1 schema before diagnosing bugs.
- Do not assume local and production schemas match.

Twilio signature validation is mandatory before any processing. Never skip it.

No secrets in code or logs. All secrets via env.SECRET_NAME through the typed Env interface.

Prefer surgical edits. Protect working behavior. No broad rewrites.

---

## Product vs GTM — Never Mix These

PRODUCT RECOVERY (src/webhooks/, src/services/, src/internal-inbox/):
- Handles real customer interactions
- SMS compliance and opt-out rules are legally significant
- Do not touch as a side effect of GTM work

GTM OUTBOUND (src/gtm/):
- Internal tooling to find and contact potential Systemix customers
- Dry-run mode and approval gates must be preserved at all times
- Stop-on-reply must be preserved
- Never allow uncontrolled live sends

---

## Internal Inbox Auth — Known Fragile Area

Cookie-backed auth across origins has caused bugs before.
- Frontend: credentials: include on all internal requests
- Backend: ALLOWED_ORIGIN must be exact — no wildcard
- Access-Control-Allow-Credentials: true required
- Cookie: HttpOnly, Secure, SameSite=None, Path=/, Max-Age
- Lovable preview URLs break auth — test against production origin only

Debug order:
1. Verify VITE_SYSTEMIX_API_BASE_URL points to correct backend
2. Verify ALLOWED_ORIGIN matches exact frontend origin
3. Test login with curl directly
4. Check Set-Cookie attributes
5. Confirm /auth/me succeeds with cookie
6. Run wrangler tail to inspect backend logs

---

## SMS Compliance — Non-Negotiable

- STOP and HELP must work on all inbound SMS paths
- Opt-outs must be persisted and respected — never send to opted-out numbers
- Message copy must match website and terms
- Never promise an exact number of messages
- Never suggest cold SMS blasting as GTM — compliance and spam risk
- Footer must include Msg and Data Rates May Apply and STOP/HELP guidance

---

## How Sean Works

Direct, surgical, systems-engineer mindset. No cheerleading.

DO:
- State exact files you intend to change before writing code
- Report: files changed, behavior changed, tests run, build result, risks remaining
- Inspect actual files before diagnosing — never assume
- Preserve approval gates and dry-run mode for all GTM sends
- Push back if the task is overbuilding before customer validation

DO NOT:
- Broad refactors or package installs outside the task scope
- Change lockfiles without explicit reason
- Claim success without verification
- Invent routes, migrations, or columns without inspecting actual files first
- Suggest internal tooling if the real bottleneck is sales

Required output format for every coding task:
1. Files I intend to change (before coding)
2. Behavior change in 3-5 bullets
3. Implementation
4. Tests run and results
5. Build result
6. Remaining risks or manual checks

---

## Current Priority Order

1. Core missed-call SMS flow working end-to-end
2. SMS compliance and Twilio A2P approval
3. Internal inbox reliable for operator use
4. Targeted outreach to real local service businesses
5. Only then: more automation or internal tooling

Challenge any task that does not serve one of these five.

---

## Deployment Commands

CANONICAL PRODUCTION WORKER: systemix-backend (https://systemix-backend.sean-ndele.workers.dev)
Deployed from "cloudflare workers/wrangler.toml" with --env production. This config
has nodejs_compat, the DB binding, the cron trigger, and all required secrets.

DO NOT deploy from api-main/api (wrangler.jsonc). The "api" worker it named was a
dormant duplicate and was DELETED on 2026-06-02; the jsonc is retained ONLY for the
vitest test harness and local dev. Deploying from it would RECREATE the dead worker.
Deploying from there for ~a month silently shipped commits to the wrong worker and
they never reached production. See
~/Brain/businesses/systemix/decisions/2026-06-02-dual-wrangler-config-deploy-trap.md.

Deploy (production):
  cd ~/Desktop/Systemix/systemix-backend/cloudflare\ workers && wrangler deploy --env production

Logs (production):
  cd ~/Desktop/Systemix/systemix-backend/cloudflare\ workers && wrangler tail --env production

Migrations (production):
  cd ~/Desktop/Systemix/systemix-backend/cloudflare\ workers && wrangler d1 migrations apply systemix --remote --env production

Tests (run in the api package):
  cd ~/Desktop/Systemix/systemix-backend/cloudflare\ workers/api-main/api && npm run test

Build (run in the api package):
  cd ~/Desktop/Systemix/systemix-backend/cloudflare\ workers/api-main/api && npm run build

---

## Tech Debt

- [DEBT] P1-3 SKIPPED: businesses table DDL duplicated in ensureSwitchboardSchema (twilioSms.ts) and ensureCustomerMissedCallSchema (missedCallRecovery.ts). intake_question column is not in any migration — it is runtime-only via maybeAddColumn. Fix requires adding a new migration (e.g. 0025_add_intake_question.sql) with an existence guard before the duplicate DDL blocks can be safely removed. Revisit when next touching schema init or migrations.

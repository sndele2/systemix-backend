# GTM Agent Layer

This folder adds a side-effect-free decision layer on top of the existing GTM backend. The current GTM service remains the execution engine for lead persistence, touchpoint timing, reply sync, stop-on-reply, and sequence advancement.

## Purpose

- Keep GTM decision logic modular and schema-validated.
- Let a manager agent route work to specialized sub-agents.
- Prevent agents from mutating live GTM state directly.
- Keep runtime tool access injectable so search and enrichment can be wired later without import-time side effects.

## Agent Roles

- `manager.ts`: routes one task at a time to the correct sub-agent using `tool()` wrappers and returns validated structured output.
- `lead-discovery.ts`: normalizes candidate business data only.
- `lead-review.ts`: approves or rejects candidates, scores them, and chooses outreach angle.
- `outreach-writer.ts`: drafts concise plain-text outbound copy only.
- `reply-interpreter.ts`: classifies inbound replies and recommends manual next action only.
- `runner.ts`: invocation-only helpers for direct sub-agent runs and manager runs.
- `schemas.ts`: all Zod output schemas plus parse helpers used to validate every final payload.

## Current Boundaries

- No agent sends email.
- No agent writes to D1.
- No agent advances sequence state.
- No agent overrides stop-on-reply.
- No agent calls Twilio.
- No file in this folder performs network access, environment access, or live service initialization at module load time.

## Integration Points

These are comments and stubs only. Do not wire them into live GTM service logic yet.

- Lead intake review:
  Call `runManagerTask({ task: 'lead_review', ... })` before a lead is admitted to an outbound queue.
- Discovery enrichment:
  Call `runLeadDiscovery(...)` before review when external search or CRM tooling is available.
- Outreach drafting:
  Call `runOutreachWriter(...)` from preview or manual approval flows before the backend execution engine sends anything.
- Reply triage:
  Call `runReplyInterpreter(...)` after reply sync if you want an advisory manual action separate from stop-on-reply enforcement.

## Wiring Live Tools Later

Runtime tools are injected through `runner.ts` as `runtimeTools`.

1. Replace the stub implementation in `buildRuntimeToolStubs(...)` with live tool bindings.
2. Keep the live tool surface read-only for discovery and review where possible.
3. If a tool can mutate state, keep that mutation outside this folder and expose only advisory or fetch behavior to agents.
4. Continue validating every sub-agent output through the parsers in `schemas.ts` before any GTM service decides what to do next.

## TODO Before Production

- Leads left in `pending` after lead-review rejection currently have no automated surfacing mechanism.
- Add a query, dashboard, or alert for stuck pending leads before this agent layer is used in production workflows.

## Example Shape

`runner.ts` expects runtime tool definitions to be passed at invocation time, for example:

```ts
{
  name: 'search_local_businesses',
  description: 'Searches candidate local businesses by market and trade',
  scopes: ['shared', 'lead_discovery'],
}
```

The current implementation treats every runtime tool call as a TODO stub and returns a structured stub payload until live bindings are added.

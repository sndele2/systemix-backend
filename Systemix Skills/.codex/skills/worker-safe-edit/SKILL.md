---
name: worker-safe-edit
version: 1.0.0
description: Ensure safe modifications to Cloudflare Worker code.
---

## Why Use This Skill

Invoke this skill when editing Cloudflare Worker endpoints to make sure modifications do not break the event‑driven architecture or degrade latency and security.

## Commands

- `check_worker_safe(edit_diff)`: Evaluate the provided code diff and identify potential violations of worker constraints.

### Parameters

- `edit_diff` (string): The unified diff of the changes you propose to the worker code.

## Operation

1. Parse the diff and scan for synchronous I/O calls within fetch handlers.
2. Flag any addition of Node.js‑specific modules or unsupported libraries.
3. Ensure `ctx.waitUntil` is used for asynchronous tasks triggered from fetch handlers.
4. Verify that response status remains `200` for webhooks and that signature/auth validation persists.
5. Return a list of warnings and required changes; if none, confirm the edit is safe.

## Example

```
> check_worker_safe(`
+ import fs from 'fs';
+ export default { async fetch(request, env, ctx) {
+   const data = fs.readFileSync('/tmp/file');
+   // Wrong: synchronous file I/O in a Worker
+ } }
`)
=> [ "Error: fs.readFileSync is not allowed in Cloudflare Workers; use async fetch or env bindings." ]
```

## Success Criteria

- No synchronous I/O or unsupported modules in worker handlers.
- All asynchronous tasks are scheduled via `ctx.waitUntil`.
- Signature checks remain intact for Stripe and internal endpoints.
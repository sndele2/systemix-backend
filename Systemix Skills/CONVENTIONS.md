# Systemix — Code Conventions

The agent must follow these conventions exactly when writing or editing code. When in doubt, match the surrounding code's style rather than inventing new patterns.

---

## Language & Runtime

- **TypeScript everywhere** — no plain `.js` files in src/
- Target: Cloudflare Workers runtime (V8 isolate) — not Node.js
- Do not use Node.js built-ins (`fs`, `path`, `process`, `Buffer` etc.) — use Web APIs
- Use Web Crypto API for hashing/signing, not `crypto` from Node

---

## File & Folder Naming

```
kebab-case/          ← folders
kebab-case.ts        ← files
kebab-case.test.ts   ← test files (co-located with source)
```

### Module structure (each submodule follows this pattern):
```
submodule/
├── AGENTS.md         ← local agent rules
├── index.ts          ← public exports only
├── handler.ts        ← entry point / routing
├── service.ts        ← business logic
├── types.ts          ← TypeScript types and interfaces
└── handler.test.ts   ← tests
```

---

## TypeScript Conventions

### Types
- Prefer `interface` over `type` for object shapes
- Use `type` for unions, intersections, and aliases
- No `any` — use `unknown` and narrow with guards
- Export types from `types.ts` — never define types inline in handlers

```ts
// ✅ Good
interface TenantContext {
  business_number: string;
  plan: 'starter' | 'pro' | 'enterprise';
}

// ❌ Bad
const handler = async (ctx: any) => { ... }
```

### Async / Await
- Always `async/await` — never raw `.then()` chains
- Always handle errors with `try/catch` — never silent failures
- Never `await` inside a loop — use `Promise.all()` for concurrency

```ts
// ✅ Good
const results = await Promise.all(items.map(item => process(item)));

// ❌ Bad
for (const item of items) {
  await process(item); // sequential, slow
}
```

### Error Handling
- Use a typed `Result` pattern for operations that can fail gracefully:

```ts
type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };
```

- Throw only for truly unexpected errors (programmer errors)
- Log errors with context — never swallow silently

---

## Cloudflare Workers Patterns

### Fetch Handler
```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. Validate auth/signature FIRST — return 401 if invalid
    // 2. Return 200 immediately for webhooks
    // 3. Offload all work to ctx.waitUntil()
    ctx.waitUntil(handleAsync(request, env));
    return new Response('OK', { status: 200 });
  }
};
```

### Environment Variables
```ts
// Always typed via the Env interface — never access env directly as a plain object
interface Env {
  DB: D1Database;
  OPENAI_API_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  TWILIO_AUTH_TOKEN: string;
  HUBSPOT_API_KEY: string;
}
```

### Never do this in a fetch handler:
```ts
// ❌ Blocks the response
const result = await db.query(...);
return Response.json(result);

// ❌ Heavy sync work
const parsed = hugeLibrary.parse(body);
```

---

## Database Conventions (D1)

### Every query must be scoped to a tenant:
```ts
// ✅ Good
const record = await env.DB
  .prepare('SELECT * FROM contacts WHERE business_number = ? AND id = ?')
  .bind(businessNumber, contactId)
  .first();

// ❌ Bad — no tenant scope
const record = await env.DB
  .prepare('SELECT * FROM contacts WHERE id = ?')
  .bind(contactId)
  .first();
```

### Use upsert semantics for tenant data:
```ts
// ✅ Preferred
INSERT INTO contacts (business_number, external_id, name)
VALUES (?, ?, ?)
ON CONFLICT (business_number, external_id) DO UPDATE SET name = excluded.name;
```

### Migration files:
- Named: `NNNN_description.sql` (e.g., `0012_add_contact_status.sql`)
- Must be idempotent (`IF NOT EXISTS`, `ON CONFLICT IGNORE`)
- Never drop columns — add nullable columns and migrate data separately

---

## AI / LLM Conventions

### Prompt structure:
```ts
const systemPrompt = `You are a routing classifier for Systemix.
Respond ONLY with valid JSON matching this schema:
{ "intent": string, "confidence": number, "metadata": object }
No prose. No markdown. No explanation.`;
```

### Always validate AI output:
```ts
function parseIntentResponse(raw: string): Result<IntentResult> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.intent || typeof parsed.confidence !== 'number') {
      return { ok: false, error: 'Invalid intent schema' };
    }
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, error: 'Non-JSON response from AI' };
  }
}
```

---

## Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Variables | camelCase | `businessNumber` |
| Constants | SCREAMING_SNAKE | `MAX_RETRY_ATTEMPTS` |
| Types / Interfaces | PascalCase | `TenantContext` |
| Files | kebab-case | `stripe-handler.ts` |
| DB columns | snake_case | `business_number` |
| Env vars | SCREAMING_SNAKE | `STRIPE_WEBHOOK_SECRET` |
| Commit messages | conventional commits | `feat(ai): add intent fallback` |

---

## Imports

Order imports as follows (separated by blank lines):
1. Web / runtime globals (none needed usually)
2. Third-party packages
3. Internal absolute imports (from submodule root)
4. Relative imports

```ts
import { Stripe } from 'stripe';

import { parseIntent } from 'ai/orchestrator';
import type { TenantContext } from 'db/types';

import { validateSignature } from './validate';
```

---

## Testing

- Tests co-located with source: `handler.test.ts` next to `handler.ts`
- Use Vitest (compatible with Workers runtime via `@cloudflare/vitest-pool-workers`)
- Mock external calls — never hit real APIs in tests
- Every new function needs at least: happy path, error path, edge case

```ts
describe('stripe-handler', () => {
  it('returns 200 immediately without awaiting processing', async () => { ... });
  it('rejects requests with invalid signature', async () => { ... });
  it('offloads processing to ctx.waitUntil', async () => { ... });
});
```

---

## What NOT to Do

- No `console.log` in production paths — use structured logging
- No `setTimeout` — use Cloudflare's scheduled workers or queues
- No `localStorage` / `sessionStorage` — not available in Workers
- No synchronous crypto (use Web Crypto API, which is async)
- No hardcoded tenant IDs, API keys, or environment-specific values
- No `require()` — ESM only

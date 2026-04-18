# Systemix Phase 7 API

Hono + Zod based Cloudflare Workers API skeleton for Phase 7.

Contents
- src/: API source (Hono app, middleware, validation)
- wrangler.jsonc: Worker configuration (D1 + KV bindings)

Quick start (local)

1. Copy environment variables for local development.

   Create `.dev.vars` (this project uses `.dev.vars` locally and it's in `.gitignore`):

   ```text
   API_KEY=your-dev-api-key
   SYSTEMIX_API_KEYS=["<sha256-hex-of-your-api-key>"]
   ENVIRONMENT=development
   ```

   For the GTM SMTP test route, add:

   ```text
   INTERNAL_AUTH_KEY=REPLACE_ME_INTERNAL_AUTH_KEY
   GTM_DRY_RUN=true
   GTM_FROM_EMAIL=REPLACE_ME_GTM_FROM_EMAIL
   GTM_FROM_NAME=Systemix
   GTM_MAX_TOUCHES=3
   SMTP_HOST=smtp.office365.com
   SMTP_PORT=587
   SMTP_USER=REPLACE_ME_SMTP_USER
   SMTP_PASS=REPLACE_ME_SMTP_PASS
   ```

   Compute SHA-256 hex for your raw key (macOS):

   ```bash
   echo -n 'my-raw-key' | shasum -a 256 | awk '{print $1}'
   ```

2. Install dependencies

   ```bash
   npm ci
   ```

3. Run the worker locally

   ```bash
   npx wrangler dev --local --port 8787
   ```

4. Test endpoints

  - Health:
    ```bash
    curl -i http://127.0.0.1:8787/health
     ```

   - Create a lead (email optional):
     ```bash
     curl -i -X POST http://127.0.0.1:8787/v1/leads \
       -H "Content-Type: application/json" \
       -d '{"name":"Test User"}'
     ```

   - Protected routes require an API key. For local dev you can pass raw key as query `?api_key=...` or set the `x-api-key` header.

  - Admin: create a widget site:
    ```bash
    curl -i -X POST http://127.0.0.1:8787/v1/admin/sites \
      -H "Content-Type: application/json" \
      -H "x-api-key: your-raw-api-key" \
      -d '{"tenantName":"Acme Co","allowedDomains":["example.com","www.example.com"],"config":{"vertical":"plumbing","brandName":"Acme Plumbing","primaryColor":"#1E88E5"}}'
    ```

  - GTM SMTP test email:
    ```bash
    curl -i -X POST http://127.0.0.1:8787/v1/internal/gtm/send-test-email \
      -H "Content-Type: application/json" \
      -H "x-internal-key: REPLACE_ME_INTERNAL_AUTH_KEY" \
      -d '{"toEmail":"you@example.com","confirmLiveSend":false}'
    ```

    This route only works when `ENVIRONMENT` is `local` or `development`.

    To send one live email, first set `GTM_DRY_RUN=false` in `.dev.vars`, then repeat the same request with `"confirmLiveSend": true`.

CI

This repo includes a GitHub Actions workflow `.github/workflows/ci.yml` that runs on push and PRs and checks TypeScript build.

D1 migrations (remote)

To apply D1 migrations to the remote database named `systemix`, ensure Wrangler is authenticated with Cloudflare (see `npx wrangler login`) and run:

```bash
npx wrangler d1 migrations apply systemix --remote
npx wrangler d1 execute systemix --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

If you prefer CI to run migrations, create a Cloudflare API token with appropriate scopes and add it as a repository secret (e.g., `WRANGLER_API_TOKEN`) — then configure workflows to use it.

Security notes

- Do NOT commit `.dev.vars` or other secret files. They are excluded by `.gitignore`.
- Rotate API keys if accidentally exposed.

Contact

If you want me to run migrations or push more changes, tell me which option you prefer (I can help with CI, docs, or tests).

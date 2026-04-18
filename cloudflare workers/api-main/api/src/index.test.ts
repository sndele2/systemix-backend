// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.ts';

const executionCtx = {
  passThroughOnException() {},
  waitUntil() {},
};

test('internal GTM test route stays in dry-run by default and bypasses unrelated startup validation', async () => {
  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/send-test-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': 'secret',
      },
      body: JSON.stringify({
        toEmail: 'test-recipient@example.com',
      }),
    }),
    {
      ENVIRONMENT: 'local',
      INTERNAL_AUTH_KEY: 'secret',
      GTM_DRY_RUN: 'true',
      SMTP_USER: 'mailbox@example.com',
    },
    executionCtx
  );

  assert.equal(response.status, 200);

  const json = await response.json();
  assert.equal(json.success, true);
  assert.equal(json.dryRun, true);
  assert.equal(json.toEmail, 'test-recipient@example.com');
  assert.equal(json.fromEmail, 'mailbox@example.com');
  assert.match(json.subject, /^Systemix GTM SMTP test /);
});

test('internal GTM test route requires explicit live confirmation when dry-run is disabled', async () => {
  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/send-test-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      },
      body: JSON.stringify({
        toEmail: 'test-recipient@example.com',
      }),
    }),
    {
      ENVIRONMENT: 'development',
      INTERNAL_AUTH_KEY: 'secret',
      GTM_DRY_RUN: 'false',
      GTM_FROM_EMAIL: 'outbound@example.com',
      SMTP_HOST: 'smtp.office365.com',
      SMTP_PORT: '587',
      SMTP_USER: 'mailbox@example.com',
      SMTP_PASS: 'secret-pass',
    },
    executionCtx
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'confirmLiveSend must be true when GTM_DRY_RUN is false',
  });
});

test('internal GTM test route is unavailable outside local development environments', async () => {
  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/send-test-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': 'secret',
      },
      body: JSON.stringify({
        toEmail: 'test-recipient@example.com',
      }),
    }),
    {
      ENVIRONMENT: 'production',
      INTERNAL_AUTH_KEY: 'secret',
      GTM_DRY_RUN: 'true',
      SMTP_USER: 'mailbox@example.com',
    },
    executionCtx
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: 'Not found',
  });
});

test('internal GTM replies route bypasses unrelated startup validation and still enforces GTM admin auth', async () => {
  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/replies'),
    {
      INTERNAL_AUTH_KEY: 'secret',
    },
    executionCtx
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: 'Unauthorized',
  });
});

test('internal GTM replies route returns 500 when INTERNAL_AUTH_KEY is missing', async () => {
  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/replies'),
    {},
    executionCtx
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: 'INTERNAL_AUTH_KEY is not configured',
  });
});

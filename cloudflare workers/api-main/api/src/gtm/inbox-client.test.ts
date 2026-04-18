// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { MicrosoftGraphInboxProvider } from './inbox-client.ts';

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

test('listMessages returns a result error when required Graph env vars are missing', async () => {
  const provider = new MicrosoftGraphInboxProvider({
    GRAPH_TENANT_ID: 'tenant-id',
  });

  assert.deepEqual(await provider.listMessages('2026-04-16T00:00:00.000Z'), {
    ok: false,
    error: 'Graph inbox configuration incomplete: GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_MAILBOX_UPN',
  });
});

test('listMessages caches the Graph access token and maps inbox messages', async () => {
  const fetchCalls = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    fetchCalls.push({
      method: init?.method ?? 'GET',
      url,
    });

    if (url.includes('/oauth2/v2.0/token')) {
      return jsonResponse({
        access_token: 'graph-token',
        expires_in: 3600,
      });
    }

    return jsonResponse({
      value: [
        {
          id: 'message-1',
          subject: 'Re: Checking in',
          from: {
            emailAddress: {
              address: 'Lead@Example.com',
            },
          },
          bodyPreview: 'Thanks for following up.',
          receivedDateTime: '2026-04-16T12:00:00.000Z',
          conversationId: 'conversation-1',
        },
      ],
    });
  };

  const provider = new MicrosoftGraphInboxProvider({
    GRAPH_TENANT_ID: 'tenant-id',
    GRAPH_CLIENT_ID: 'client-id',
    GRAPH_CLIENT_SECRET: 'client-secret',
    GRAPH_MAILBOX_UPN: 'mailbox@example.com',
  });

  const firstResult = await provider.listMessages('2026-04-16T00:00:00.000Z');
  const secondResult = await provider.listMessages('2026-04-16T13:00:00.000Z');

  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.deepEqual(firstResult.value, [
    {
      id: 'message-1',
      fromEmail: 'lead@example.com',
      subject: 'Re: Checking in',
      bodySnippet: 'Thanks for following up.',
      receivedAt: '2026-04-16T12:00:00.000Z',
      conversationId: 'conversation-1',
      rawProviderId: 'message-1',
    },
  ]);

  assert.equal(fetchCalls.filter((call) => call.url.includes('/oauth2/v2.0/token')).length, 1);
  assert.equal(fetchCalls.filter((call) => call.url.includes('/mailFolders/Inbox/messages')).length, 2);
});

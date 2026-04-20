// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

import { createInternalInboxHandler } from './handler.ts';

function createInternalInboxProviderStub() {
  const calls = {
    getConversation: [],
    listConversations: [],
    replyToConversation: [],
  };

  return {
    calls,
    provider: {
      async listConversations(businessNumber, limit) {
        calls.listConversations.push({ businessNumber, limit });
        return {
          ok: true,
          value: [
            {
              id: '+18443217137:+12175550123',
              businessNumber: '+18443217137',
              contact: {
                phoneNumber: '+12175550123',
              },
              source: 'sms',
              preview: 'Please call me back.',
              updatedAt: '2026-04-16T12:00:00.000Z',
            },
          ],
        };
      },
      async getConversation(businessNumber, conversationId) {
        calls.getConversation.push({ businessNumber, conversationId });

        if (conversationId === 'missing-conversation') {
          return {
            ok: true,
            value: null,
          };
        }

        return {
          ok: true,
          value: {
            id: conversationId,
            businessNumber: '+18443217137',
            contact: {
              phoneNumber: '+12175550123',
            },
            source: 'sms',
            updatedAt: '2026-04-16T12:00:00.000Z',
            messages: [
              {
                id: 'message-1',
                type: 'customer',
                source: 'sms',
                body: 'Please call me back.',
                timestamp: '2026-04-16T12:00:00.000Z',
                rawProviderId: 'message-1',
              },
            ],
          },
        };
      },
      async replyToConversation(businessNumber, conversationId, body) {
        calls.replyToConversation.push({ businessNumber, conversationId, body });
        return { ok: true, value: undefined };
      },
    },
  };
}

function createScopedApp(provider) {
  const app = new Hono();
  app.use('/v1/internal/*', async (c, next) => {
    c.set('internalSession', {
      businessNumber: '+18443217137',
    });
    await next();
  });
  app.route('/', createInternalInboxHandler(() => provider));
  return app;
}

test('lists inbox conversations', async () => {
  const { provider, calls } = createInternalInboxProviderStub();
  const app = createScopedApp(provider);

  const response = await app.request('http://example.com/v1/internal/inbox/conversations?limit=25');

  assert.equal(response.status, 200);
  assert.deepEqual(calls.listConversations, [
    {
      businessNumber: '+18443217137',
      limit: 25,
    },
  ]);
  assert.deepEqual(await response.json(), {
    conversations: [
      {
        id: '+18443217137:+12175550123',
        businessNumber: '+18443217137',
        contact: {
          phoneNumber: '+12175550123',
        },
        source: 'sms',
        preview: 'Please call me back.',
        updatedAt: '2026-04-16T12:00:00.000Z',
      },
    ],
  });
});

test('returns a single inbox conversation', async () => {
  const { provider, calls } = createInternalInboxProviderStub();
  const app = createScopedApp(provider);

  const response = await app.request(
    'http://example.com/v1/internal/inbox/conversations/conversation-1'
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls.getConversation, [
    {
      businessNumber: '+18443217137',
      conversationId: 'conversation-1',
    },
  ]);
  assert.deepEqual(await response.json(), {
    conversation: {
      id: 'conversation-1',
      businessNumber: '+18443217137',
      contact: {
        phoneNumber: '+12175550123',
      },
      source: 'sms',
      updatedAt: '2026-04-16T12:00:00.000Z',
      messages: [
        {
          id: 'message-1',
          type: 'customer',
          source: 'sms',
          body: 'Please call me back.',
          timestamp: '2026-04-16T12:00:00.000Z',
          rawProviderId: 'message-1',
        },
      ],
    },
  });
});

test('replies to an inbox conversation', async () => {
  const { provider, calls } = createInternalInboxProviderStub();
  const app = createScopedApp(provider);

  const response = await app.request(
    'http://example.com/v1/internal/inbox/conversations/conversation-1/reply',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: 'Thanks, we will call you back shortly.',
      }),
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls.replyToConversation, [
    {
      businessNumber: '+18443217137',
      conversationId: 'conversation-1',
      body: 'Thanks, we will call you back shortly.',
    },
  ]);
  assert.deepEqual(await response.json(), { ok: true });
});

test('returns 404 when the inbox conversation is missing', async () => {
  const { provider, calls } = createInternalInboxProviderStub();
  const app = createScopedApp(provider);

  const response = await app.request(
    'http://example.com/v1/internal/inbox/conversations/missing-conversation'
  );

  assert.equal(response.status, 404);
  assert.deepEqual(calls.getConversation, [
    {
      businessNumber: '+18443217137',
      conversationId: 'missing-conversation',
    },
  ]);
  assert.deepEqual(await response.json(), {
    error: 'Conversation not found',
  });
});

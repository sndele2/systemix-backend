import { Hono } from 'hono';

import type { InternalSession } from '../core/internal-auth.ts';
import { D1InternalInboxProvider } from './provider.ts';

import type { InternalInboxProvider, Result } from './types.ts';

interface InternalInboxBindings {
  SYSTEMIX: D1Database;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
  SYSTEMIX_NUMBER?: string;
}

interface ConversationReplyRequestBody {
  body?: string;
}

function jsonError(
  error: string,
  status: 400 | 404 | 500 | 502
): Response {
  return Response.json({ error }, { status });
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function normalizeLimit(rawLimit: string | undefined): Result<number> {
  if (rawLimit === undefined) {
    return { ok: true, value: 50 };
  }

  const parsedLimit = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
    return { ok: false, error: 'limit must be a positive integer' };
  }

  return { ok: true, value: Math.min(parsedLimit, 200) };
}

function normalizeReplyBody(body: ConversationReplyRequestBody | null): Result<string> {
  const replyBody = typeof body?.body === 'string' ? body.body.trim() : '';
  if (replyBody.length === 0) {
    return { ok: false, error: 'body is required' };
  }

  return { ok: true, value: replyBody };
}

function mapInboxErrorToStatus(error: string): 400 | 404 | 500 | 502 {
  if (
    error === 'Conversation id is required' ||
    error === 'Invalid conversation id' ||
    error === 'body is required' ||
    error === 'Reply suppressed because recipient cannot receive SMS'
  ) {
    return 400;
  }

  if (error === 'Conversation not found') {
    return 404;
  }

  if (error.startsWith('twilio_sms_failed_') || error.startsWith('twilio_sms_error:')) {
    return 502;
  }

  return 500;
}

export function createInternalInboxHandler(
  inboxProviderFactory: (bindings: InternalInboxBindings) => InternalInboxProvider = (bindings) =>
    new D1InternalInboxProvider(bindings)
): Hono<{
  Bindings: InternalInboxBindings;
  Variables: {
    internalSession: InternalSession;
  };
}> {
  const app = new Hono<{
    Bindings: InternalInboxBindings;
    Variables: {
      internalSession: InternalSession;
    };
  }>();

  app.get('/v1/internal/inbox/conversations', async (c) => {
    const limitResult = normalizeLimit(c.req.query('limit'));
    if (!limitResult.ok) {
      return jsonError(limitResult.error, 400);
    }

    const session = c.get('internalSession');
    const inboxProvider = inboxProviderFactory(c.env);
    const conversationsResult = await inboxProvider.listConversations(
      session.businessNumber,
      limitResult.value
    );
    if (!conversationsResult.ok) {
      return jsonError(conversationsResult.error, mapInboxErrorToStatus(conversationsResult.error));
    }

    return c.json(
      {
        conversations: conversationsResult.value,
      },
      200
    );
  });

  app.get('/v1/internal/inbox/conversations/:conversationId', async (c) => {
    const session = c.get('internalSession');
    const inboxProvider = inboxProviderFactory(c.env);
    const conversationResult = await inboxProvider.getConversation(
      session.businessNumber,
      c.req.param('conversationId')
    );
    if (!conversationResult.ok) {
      return jsonError(conversationResult.error, mapInboxErrorToStatus(conversationResult.error));
    }

    if (conversationResult.value === null) {
      return jsonError('Conversation not found', 404);
    }

    return c.json(
      {
        conversation: conversationResult.value,
      },
      200
    );
  });

  app.post('/v1/internal/inbox/conversations/:conversationId/reply', async (c) => {
    const body = await readJsonBody<ConversationReplyRequestBody>(c.req.raw);
    if (body === null) {
      return jsonError('Invalid JSON body', 400);
    }

    const replyBodyResult = normalizeReplyBody(body);
    if (!replyBodyResult.ok) {
      return jsonError(replyBodyResult.error, 400);
    }

    const session = c.get('internalSession');
    const inboxProvider = inboxProviderFactory(c.env);
    const replyResult = await inboxProvider.replyToConversation(
      session.businessNumber,
      c.req.param('conversationId'),
      replyBodyResult.value
    );
    if (!replyResult.ok) {
      return jsonError(replyResult.error, mapInboxErrorToStatus(replyResult.error));
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}

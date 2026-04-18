/**
 * Outlook inbox reply sync for internal GTM review.
 *
 * Required environment variables:
 * - GRAPH_TENANT_ID
 * - GRAPH_CLIENT_ID
 * - GRAPH_CLIENT_SECRET
 * - GRAPH_MAILBOX_UPN
 *
 * Required Microsoft Graph application permission:
 * - Mail.Read
 *
 * This client uses the client-credentials flow with fetch only and keeps the
 * access token in module memory until it expires.
 */
import type { InboxMessage, InboxProvider, Result } from './types.ts';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH_API_HOST = 'https://graph.microsoft.com';
const GRAPH_MESSAGE_PAGE_SIZE = 50;
const GRAPH_TOKEN_EXPIRY_SKEW_MS = 60_000;

interface GraphInboxEnv {
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CLIENT_SECRET?: string;
  GRAPH_MAILBOX_UPN?: string;
}

interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailboxUpn: string;
}

interface CachedGraphToken {
  accessToken: string;
  cacheKey: string;
  expiresAtMs: number;
}

interface GraphTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

interface GraphMessageResponse {
  value?: unknown;
}

interface GraphMessagePayload {
  bodyPreview?: unknown;
  conversationId?: unknown;
  from?: {
    emailAddress?: {
      address?: unknown;
    };
  } | null;
  id?: unknown;
  receivedDateTime?: unknown;
  subject?: unknown;
}

let cachedGraphToken: CachedGraphToken | null = null;

function succeed<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

function resolveGraphConfig(env: GraphInboxEnv): Result<GraphConfig> {
  const missingFields: string[] = [];

  if (!env.GRAPH_TENANT_ID?.trim()) {
    missingFields.push('GRAPH_TENANT_ID');
  }

  if (!env.GRAPH_CLIENT_ID?.trim()) {
    missingFields.push('GRAPH_CLIENT_ID');
  }

  if (!env.GRAPH_CLIENT_SECRET?.trim()) {
    missingFields.push('GRAPH_CLIENT_SECRET');
  }

  if (!env.GRAPH_MAILBOX_UPN?.trim()) {
    missingFields.push('GRAPH_MAILBOX_UPN');
  }

  if (missingFields.length > 0) {
    return fail('Graph inbox configuration incomplete: ' + missingFields.join(', '));
  }

  return succeed({
    tenantId: env.GRAPH_TENANT_ID!.trim(),
    clientId: env.GRAPH_CLIENT_ID!.trim(),
    clientSecret: env.GRAPH_CLIENT_SECRET!,
    mailboxUpn: env.GRAPH_MAILBOX_UPN!.trim(),
  });
}

function buildCacheKey(config: GraphConfig): string {
  return [config.tenantId, config.clientId, config.mailboxUpn.toLowerCase()].join(':');
}

function trimBodySnippet(value: string): string {
  return value.slice(0, 500);
}

function extractFromEmailAddress(message: GraphMessagePayload): string {
  const address = message.from?.emailAddress?.address;
  return typeof address === 'string' ? address.trim().toLowerCase() : '';
}

function mapGraphMessage(message: GraphMessagePayload): Result<InboxMessage> {
  if (typeof message.id !== 'string' || message.id.trim().length === 0) {
    return fail('Graph inbox response contained a message without an id');
  }

  if (
    typeof message.receivedDateTime !== 'string' ||
    message.receivedDateTime.trim().length === 0 ||
    Number.isNaN(Date.parse(message.receivedDateTime))
  ) {
    return fail('Graph inbox response contained a message with an invalid receivedDateTime');
  }

  return succeed({
    id: message.id.trim(),
    fromEmail: extractFromEmailAddress(message),
    subject: typeof message.subject === 'string' ? message.subject : null,
    bodySnippet: typeof message.bodyPreview === 'string' ? trimBodySnippet(message.bodyPreview) : '',
    receivedAt: message.receivedDateTime,
    conversationId: typeof message.conversationId === 'string' ? message.conversationId : null,
    rawProviderId: message.id.trim(),
  });
}

async function parseJsonResponse<T>(response: Response): Promise<Result<T>> {
  try {
    return succeed((await response.json()) as T);
  } catch {
    return fail('Failed to parse Microsoft Graph JSON response');
  }
}

export class MicrosoftGraphInboxProvider implements InboxProvider {
  private readonly configResult: Result<GraphConfig>;

  constructor(env: GraphInboxEnv) {
    this.configResult = resolveGraphConfig(env);
  }

  async listMessages(cursor: string): Promise<Result<InboxMessage[]>> {
    if (!this.configResult.ok) {
      return this.configResult;
    }

    const tokenResult = await this.getAccessToken(this.configResult.value);
    if (!tokenResult.ok) {
      return tokenResult;
    }

    const url = new URL(
      `${GRAPH_API_HOST}/v1.0/users/${encodeURIComponent(this.configResult.value.mailboxUpn)}/mailFolders/Inbox/messages`
    );
    url.searchParams.set('$filter', `receivedDateTime gt ${cursor}`);
    url.searchParams.set(
      '$select',
      'id,subject,from,bodyPreview,receivedDateTime,conversationId'
    );
    url.searchParams.set('$orderby', 'receivedDateTime asc');
    url.searchParams.set('$top', String(GRAPH_MESSAGE_PAGE_SIZE));

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokenResult.value}`,
        },
      });
    } catch (error) {
      return fail(
        'Microsoft Graph inbox request failed: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }

    if (!response.ok) {
      return fail(`Microsoft Graph inbox request failed with status ${response.status}`);
    }

    const bodyResult = await parseJsonResponse<GraphMessageResponse>(response);
    if (!bodyResult.ok) {
      return bodyResult;
    }

    if (!Array.isArray(bodyResult.value.value)) {
      return fail('Microsoft Graph inbox response did not include a value array');
    }

    const messages: InboxMessage[] = [];

    for (const entry of bodyResult.value.value) {
      const mappedMessageResult = mapGraphMessage((entry ?? {}) as GraphMessagePayload);
      if (!mappedMessageResult.ok) {
        return mappedMessageResult;
      }

      messages.push(mappedMessageResult.value);
    }

    return succeed(messages);
  }

  private async getAccessToken(config: GraphConfig): Promise<Result<string>> {
    const cacheKey = buildCacheKey(config);

    if (
      cachedGraphToken !== null &&
      cachedGraphToken.cacheKey === cacheKey &&
      Date.now() < cachedGraphToken.expiresAtMs
    ) {
      return succeed(cachedGraphToken.accessToken);
    }

    const tokenUrl = `${GRAPH_TOKEN_HOST}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
    const requestBody = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: GRAPH_SCOPE,
    });

    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: requestBody,
      });
    } catch (error) {
      return fail(
        'Microsoft Graph token request failed: ' +
          (error instanceof Error ? error.message : String(error))
      );
    }

    if (!response.ok) {
      return fail(`Microsoft Graph token request failed with status ${response.status}`);
    }

    const tokenBodyResult = await parseJsonResponse<GraphTokenResponse>(response);
    if (!tokenBodyResult.ok) {
      return tokenBodyResult;
    }

    if (
      typeof tokenBodyResult.value.access_token !== 'string' ||
      tokenBodyResult.value.access_token.trim().length === 0
    ) {
      return fail('Microsoft Graph token response did not include access_token');
    }

    const expiresInSeconds =
      typeof tokenBodyResult.value.expires_in === 'number'
        ? tokenBodyResult.value.expires_in
        : Number.parseInt(String(tokenBodyResult.value.expires_in ?? ''), 10);

    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
      return fail('Microsoft Graph token response did not include a valid expires_in value');
    }

    cachedGraphToken = {
      accessToken: tokenBodyResult.value.access_token,
      cacheKey,
      expiresAtMs:
        Date.now() +
        Math.max(1_000, expiresInSeconds * 1_000 - GRAPH_TOKEN_EXPIRY_SKEW_MS),
    };

    return succeed(tokenBodyResult.value.access_token);
  }
}

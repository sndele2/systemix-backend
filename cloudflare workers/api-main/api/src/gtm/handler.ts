/**
 * Defines isolated GTM routes without mounting them into the main worker router.
 */
import { Hono, type Context } from 'hono';

import type { Lead, LeadRecord, Result } from './types.ts';
import type { LeadDiscoveryOutput } from './agents/schemas.ts';

import { GTMService } from './service.ts';
import { parseLeadDiscoveryInput } from './agents/schemas.ts';

const GTM_LOG_PREFIX = '[GTM]';
const AGENT_TIMEOUT_MS = 12_000;

interface GTMHandlerBindings {
  INTERNAL_AUTH_KEY?: string;
  GTM_DB?: D1Database;
}

interface ManualTriggerRequestBody {
  leadIds?: string[];
}

interface ManualPreviewItem {
  leadId: string;
  status: LeadRecord['status'] | 'unknown';
  touchesSent: number;
  action: 'send' | 'stop' | 'error' | 'skipped';
  reason: string;
  stageIndex?: 0 | 1 | 2;
  subject?: string;
  body?: string;
}

interface ManualAdvanceItem {
  leadId: string;
  action: 'sent' | 'stopped' | 'skipped' | 'error';
  reason: string;
}

interface GtmHandlerAgentDependencies {
  runLeadDiscovery?: (input: unknown) => Promise<LeadDiscoveryOutput>;
}

function jsonError(
  c: Context<{ Bindings: GTMHandlerBindings }>,
  message: string,
  status: 400 | 401 | 404 | 500 | 502
): Response {
  return c.json({ error: message }, status);
}

function logInfo(event: string, data: Record<string, unknown> = {}): void {
  console.log(GTM_LOG_PREFIX + ' ' + event, {
    ts: new Date().toISOString(),
    ...data,
  });
}

function logError(event: string, error: unknown, data: Record<string, unknown> = {}): void {
  console.error(GTM_LOG_PREFIX + ' ' + event, {
    ts: new Date().toISOString(),
    ...data,
    error: error instanceof Error ? error.message : String(error),
  });
}

async function readJsonBody<T>(c: Context<{ Bindings: GTMHandlerBindings }>): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

async function readOptionalJsonBody<T>(
  c: Context<{ Bindings: GTMHandlerBindings }>
): Promise<Result<T | null>> {
  const contentLength = c.req.header('content-length');
  const contentType = c.req.header('content-type');
  const hasBody =
    (contentLength !== undefined && Number(contentLength) > 0) ||
    (typeof contentType === 'string' && contentType.toLowerCase().includes('application/json'));

  if (!hasBody) {
    return { ok: true, value: null };
  }

  const body = await readJsonBody<T>(c);
  if (body === null) {
    return { ok: false, error: 'Invalid JSON body' };
  }

  return { ok: true, value: body };
}

function normalizeLeadIds(body: ManualTriggerRequestBody | null): Result<string[] | null> {
  if (body === null || body.leadIds === undefined) {
    return { ok: true, value: null };
  }

  if (!Array.isArray(body.leadIds)) {
    return { ok: false, error: 'leadIds must be an array of non-empty strings' };
  }

  const normalizedLeadIds: string[] = [];
  const seenLeadIds = new Set<string>();

  for (const leadId of body.leadIds) {
    if (typeof leadId !== 'string') {
      return { ok: false, error: 'leadIds must be an array of non-empty strings' };
    }

    const trimmedLeadId = leadId.trim();
    if (trimmedLeadId.length === 0) {
      return { ok: false, error: 'leadIds must be an array of non-empty strings' };
    }

    if (!seenLeadIds.has(trimmedLeadId)) {
      seenLeadIds.add(trimmedLeadId);
      normalizedLeadIds.push(trimmedLeadId);
    }
  }

  return { ok: true, value: normalizedLeadIds };
}

function respondWithResult<T>(
  c: Context<{ Bindings: GTMHandlerBindings }>,
  result: Result<T>,
  successStatus: 200 | 201 | 202 = 200
): Response {
  if (!result.ok) {
    return jsonError(c, result.error, 400);
  }

  return c.json(result.value, successStatus);
}

function handleUnexpectedError(c: Context<{ Bindings: GTMHandlerBindings }>, error: unknown): Response {
  logError('handler_error', error);
  return jsonError(c, 'Internal server error', 500);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(label + ' timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        resolve(value);
      },
      (error) => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        reject(error);
      }
    );
  });
}

function requireInternalAuth(c: Context<{ Bindings: GTMHandlerBindings }>): Response | null {
  const expectedAuthKey = c.env?.INTERNAL_AUTH_KEY?.trim();
  if (!expectedAuthKey) {
    return jsonError(c, 'Unauthorized', 401);
  }

  const authorization = c.req.header('Authorization');
  if (authorization === `Bearer ${expectedAuthKey}`) {
    return null;
  }

  const internalKeyHeader = c.req.header('x-internal-key');
  if (internalKeyHeader === expectedAuthKey) {
    return null;
  }

  return jsonError(c, 'Unauthorized', 401);
}

function normalizeReplyLimit(rawLimit: string | undefined): Result<number> {
  if (rawLimit === undefined) {
    return { ok: true, value: 50 };
  }

  const parsedLimit = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
    return { ok: false, error: 'limit must be a positive integer' };
  }

  return { ok: true, value: Math.min(parsedLimit, 200) };
}

function normalizeMatchedOnly(rawValue: string | undefined): Result<boolean> {
  if (rawValue === undefined) {
    return { ok: true, value: false };
  }

  const normalizedValue = rawValue.trim().toLowerCase();
  if (normalizedValue === 'true') {
    return { ok: true, value: true };
  }

  if (normalizedValue === 'false') {
    return { ok: true, value: false };
  }

  return { ok: false, error: 'matched_only must be true or false' };
}

function filterEligibleLeads(leads: LeadRecord[], requestedLeadIds: string[] | null): LeadRecord[] {
  if (requestedLeadIds === null) {
    return leads;
  }

  const requestedLeadIdSet = new Set(requestedLeadIds);
  return leads.filter((lead) => requestedLeadIdSet.has(lead.id));
}

function buildSkippedPreviewItems(
  eligibleLeads: LeadRecord[],
  requestedLeadIds: string[] | null
): ManualPreviewItem[] {
  if (requestedLeadIds === null) {
    return [];
  }

  const eligibleLeadIdSet = new Set(eligibleLeads.map((lead) => lead.id));

  return requestedLeadIds
    .filter((leadId) => !eligibleLeadIdSet.has(leadId))
    .map((leadId) => ({
      leadId,
      status: 'unknown',
      touchesSent: 0,
      action: 'skipped',
      reason: 'not_ready_for_next_action',
    }));
}

function buildSkippedAdvanceItems(
  eligibleLeads: LeadRecord[],
  requestedLeadIds: string[] | null
): ManualAdvanceItem[] {
  if (requestedLeadIds === null) {
    return [];
  }

  const eligibleLeadIdSet = new Set(eligibleLeads.map((lead) => lead.id));

  return requestedLeadIds
    .filter((leadId) => !eligibleLeadIdSet.has(leadId))
    .map((leadId) => ({
      leadId,
      action: 'skipped',
      reason: 'not_ready_for_next_action',
    }));
}

async function previewEligibleLeads(
  service: GTMService,
  eligibleLeads: LeadRecord[]
): Promise<ManualPreviewItem[]> {
  return Promise.all(
    eligibleLeads.map(async (lead) => {
      const preparedActionResult = await service.prepareNextAction(lead.id);

      if (!preparedActionResult.ok) {
        logError('manual_preview_prepare_failed', new Error(preparedActionResult.error), {
          leadId: lead.id,
        });

        return {
          leadId: lead.id,
          status: lead.status,
          touchesSent: lead.touches_sent,
          action: 'error',
          reason: preparedActionResult.error,
        } satisfies ManualPreviewItem;
      }

      if (preparedActionResult.value.action === 'stop') {
        return {
          leadId: lead.id,
          status: lead.status,
          touchesSent: lead.touches_sent,
          action: 'stop',
          reason: preparedActionResult.value.reason,
        } satisfies ManualPreviewItem;
      }

      return {
        leadId: lead.id,
        status: lead.status,
        touchesSent: lead.touches_sent,
        action: 'send',
        reason: 'ready_for_next_action',
        stageIndex: preparedActionResult.value.stage.stageIndex,
        subject: preparedActionResult.value.subject,
        body: preparedActionResult.value.body,
      } satisfies ManualPreviewItem;
    })
  );
}

async function advanceEligibleLeads(
  service: GTMService,
  eligibleLeads: LeadRecord[]
): Promise<ManualAdvanceItem[]> {
  return Promise.all(
    eligibleLeads.map(async (lead) => {
      const advanceResult = await service.advanceLeadSequence(lead.id);

      if (!advanceResult.ok) {
        logError('manual_advance_failed', new Error(advanceResult.error), {
          leadId: lead.id,
        });

        return {
          leadId: lead.id,
          action: 'error',
          reason: advanceResult.error,
        } satisfies ManualAdvanceItem;
      }

      return {
        leadId: advanceResult.value.leadId,
        action: advanceResult.value.action,
        reason: advanceResult.value.reason ?? 'advanced',
      } satisfies ManualAdvanceItem;
    })
  );
}

export function createGtmHandler(
  service: GTMService,
  agentDependencies: GtmHandlerAgentDependencies = {}
): Hono<{ Bindings: GTMHandlerBindings }> {
  const app = new Hono<{ Bindings: GTMHandlerBindings }>();

  app.post('/gtm/leads', async (c) => {
    const body = await readJsonBody<Lead>(c);
    if (!body) {
      return jsonError(c, 'Invalid JSON body', 400);
    }

    try {
      return respondWithResult(c, await service.createLead(body), 201);
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  app.post('/gtm/sequences/:leadId/start', async (c) => {
    try {
      return respondWithResult(c, await service.startSequence(c.req.param('leadId')), 202);
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  app.get('/gtm/sequences/:leadId/next', async (c) => {
    try {
      return respondWithResult(c, await service.prepareNextAction(c.req.param('leadId')), 200);
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  app.post('/gtm/sequences/:leadId/advance', async (c) => {
    try {
      return respondWithResult(c, await service.advanceLeadSequence(c.req.param('leadId')), 202);
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  app.get('/gtm/sequences/ready', async (c) => {
    try {
      return respondWithResult(c, await service.getLeadsReadyForNextAction(), 200);
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  app.post('/gtm/internal/manual/preview', async (c) => {
    const authError = requireInternalAuth(c);
    if (authError) {
      return authError;
    }

    const bodyResult = await readOptionalJsonBody<ManualTriggerRequestBody>(c);
    if (!bodyResult.ok) {
      return jsonError(c, bodyResult.error, 400);
    }

    const requestedLeadIdsResult = normalizeLeadIds(bodyResult.value);
    if (!requestedLeadIdsResult.ok) {
      return jsonError(c, requestedLeadIdsResult.error, 400);
    }

    try {
      const readyLeadsResult = await service.getLeadsReadyForNextAction();
      if (!readyLeadsResult.ok) {
        return respondWithResult(c, readyLeadsResult, 200);
      }

      const eligibleLeads = filterEligibleLeads(readyLeadsResult.value, requestedLeadIdsResult.value);
      const previewItems = await previewEligibleLeads(service, eligibleLeads);
      const skippedItems = buildSkippedPreviewItems(eligibleLeads, requestedLeadIdsResult.value);

      logInfo('manual_preview_completed', {
        requestedCount: requestedLeadIdsResult.value?.length ?? null,
        eligibleCount: eligibleLeads.length,
      });

      return c.json(
        {
          requestedLeadIds: requestedLeadIdsResult.value,
          eligibleCount: eligibleLeads.length,
          results: [...previewItems, ...skippedItems],
        },
        200
      );
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  app.post('/gtm/internal/manual/advance', async (c) => {
    const authError = requireInternalAuth(c);
    if (authError) {
      return authError;
    }

    const bodyResult = await readOptionalJsonBody<ManualTriggerRequestBody>(c);
    if (!bodyResult.ok) {
      return jsonError(c, bodyResult.error, 400);
    }

    const requestedLeadIdsResult = normalizeLeadIds(bodyResult.value);
    if (!requestedLeadIdsResult.ok) {
      return jsonError(c, requestedLeadIdsResult.error, 400);
    }

    try {
      const readyLeadsResult = await service.getLeadsReadyForNextAction();
      if (!readyLeadsResult.ok) {
        return respondWithResult(c, readyLeadsResult, 202);
      }

      const eligibleLeads = filterEligibleLeads(readyLeadsResult.value, requestedLeadIdsResult.value);
      const advanceItems = await advanceEligibleLeads(service, eligibleLeads);
      const skippedItems = buildSkippedAdvanceItems(eligibleLeads, requestedLeadIdsResult.value);

      logInfo('manual_advance_completed', {
        requestedCount: requestedLeadIdsResult.value?.length ?? null,
        eligibleCount: eligibleLeads.length,
        errorCount: advanceItems.filter((item) => item.action === 'error').length,
      });

      return c.json(
        {
          requestedLeadIds: requestedLeadIdsResult.value,
          eligibleCount: eligibleLeads.length,
          results: [...advanceItems, ...skippedItems],
        },
        202
      );
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  app.post('/gtm/internal/discovery', async (c) => {
    const authError = requireInternalAuth(c);
    if (authError) {
      return authError;
    }

    const body = await readJsonBody<unknown>(c);
    if (!body) {
      return jsonError(c, 'Invalid JSON body', 400);
    }

    let parsedInput;
    try {
      parsedInput = parseLeadDiscoveryInput(body);
    } catch (error) {
      logError('gtm_internal_discovery_invalid_input', error);
      return jsonError(c, 'Invalid discovery request body', 400);
    }

    if (!agentDependencies.runLeadDiscovery) {
      return c.json(
        {
          agent_status: 'fallback',
          candidates: [],
          limitations: ['Lead discovery agent is not configured'],
        },
        200
      );
    }

    try {
      const result = await withTimeout(
        agentDependencies.runLeadDiscovery(parsedInput),
        AGENT_TIMEOUT_MS,
        'lead discovery agent'
      );

      return c.json(
        {
          agent_status: 'ok',
          candidates: result.candidates,
          limitations: result.limitations,
        },
        200
      );
    } catch (error) {
      logError('gtm_internal_discovery_fallback', error, {
        fallback: 'empty_discovery_result',
      });

      return c.json(
        {
          agent_status: 'fallback',
          candidates: [],
          limitations: ['Lead discovery agent failed; returned empty fallback result'],
        },
        200
      );
    }
  });

  app.post('/gtm/replies/inbound', async (c) => {
    const body = await readJsonBody<{ leadId?: string; rawReply?: string }>(c);
    if (!body || typeof body.leadId !== 'string' || typeof body.rawReply !== 'string') {
      return jsonError(c, 'Invalid JSON body', 400);
    }

    try {
      return respondWithResult(c, await service.recordReply(body.leadId, body.rawReply), 202);
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  return app;
}

export function createGtmInternalRepliesHandler(
  serviceFactory: (bindings: GTMHandlerBindings) => GTMService
): Hono<{ Bindings: GTMHandlerBindings }> {
  const app = new Hono<{ Bindings: GTMHandlerBindings }>();

  app.get('/v1/internal/gtm/replies', async (c) => {
    const limitResult = normalizeReplyLimit(c.req.query('limit'));
    if (!limitResult.ok) {
      return jsonError(c, limitResult.error, 400);
    }

    const matchedOnlyResult = normalizeMatchedOnly(c.req.query('matched_only'));
    if (!matchedOnlyResult.ok) {
      return jsonError(c, matchedOnlyResult.error, 400);
    }

    if (!c.env?.GTM_DB) {
      return jsonError(c, 'GTM_DB is not configured', 500);
    }

    try {
      const service = serviceFactory(c.env);
      const result = await service.syncAndListReplies(limitResult.value, matchedOnlyResult.value);

      if (!result.ok) {
        const status = result.error.startsWith('Microsoft Graph') ? 502 : 500;
        return jsonError(c, result.error, status);
      }

      return c.json(result.value, 200);
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  app.get('/v1/internal/gtm/replies/:leadId', async (c) => {
    if (!c.env?.GTM_DB) {
      return jsonError(c, 'GTM_DB is not configured', 500);
    }

    try {
      const service = serviceFactory(c.env);
      const result = await service.listRepliesForLead(c.req.param('leadId'));

      if (!result.ok) {
        if (result.error === 'Lead not found') {
          return jsonError(c, result.error, 404);
        }

        return jsonError(c, result.error, 500);
      }

      return c.json(result.value, 200);
    } catch (error) {
      return handleUnexpectedError(c, error);
    }
  });

  return app;
}

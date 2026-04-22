import { Hono, type Context } from 'hono';
import {
  authenticateInternalUser,
  clearInternalSession,
  createBootstrapOwner,
  createInternalSession,
  createInternalSessionStore,
  createInternalUserAccount,
  createInternalUserStore,
  getInternalSessionWithStore,
  isLegacyGtmAdminAuthorized,
  normalizeInternalBusinessNumber,
  normalizeInternalDisplayName,
  normalizeInternalUsername,
  resolveInternalCorsPolicy,
  resolveInternalCorsHeaders,
  type InternalSession,
  type InternalSessionStore,
  type InternalUserRole,
  type InternalUserStore,
  type Result as AuthResult,
} from './core/internal-auth.ts';
import { createLogger } from './core/logging.ts';
import { createTwilioRestClient } from './core/sms.ts';
import { resolveGtmConfigFromEnv, sendGtmTestEmail } from './gtm/email-client.ts';
import { MicrosoftGraphInboxProvider } from './gtm/inbox-client.ts';
import {
  createGtmInternalFlowHandler,
  createGtmInternalRepliesHandler,
  createRuntimeGtmService,
} from './gtm/index.ts';
import type { ApprovalNotificationRequest, GTMServiceApprovalHooks } from './gtm/service.ts';
import {
  createInternalInboxHandler,
  D1InternalInboxProvider,
  type InternalInboxProvider,
} from './internal-inbox/index.ts';
import { normalizePhone } from './services/smsCompliance.ts';
import { scheduleTwilioBackgroundTask } from './services/twilioLaunch.ts';
import { upsertBusiness } from './services/database.ts';
import {
  ensureCustomerMissedCallSchema,
  getMissedCallRecoveryStats,
  ignoreMissedCallNumber,
  RECOVERED_OPPORTUNITY_DEFINITION,
} from './services/missedCallRecovery.ts';
import { simulateCallbackHandler } from './testing/simulator.ts';
import { stripeWebhookHandler } from './webhooks/stripe.ts';
import { twilioStatusHandler } from './webhooks/twilioStatus.ts';
import { checkEmergencyTimeouts, twilioSmsHandler } from './webhooks/twilioSms.ts';
import {
  twilioDialStatusHandler,
  twilioRecordingHandler,
  twilioVoiceHandler,
  twilioVoicemailTranscriptionHandler,
} from './webhooks/twilioVoice.ts';

type Bindings = {
  SYSTEMIX: D1Database;
  DB?: D1Database;
  GTM_DB?: D1Database;
  GTM_LIVE_TEST_KEY?: string;
  OPENAI_API_KEY: string;
  CLIENT_PHONE: string;
  OWNER_PHONE_NUMBER?: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;
  TWILIO_SIGNATURE_MODE?: string;
  ENVIRONMENT?: string;
  WORKER_URL?: string;
  SYSTEMIX_NUMBER: string;
  SIMULATOR_API_KEY?: string;
  VOICE_CONSENT_SCRIPT?: string;
  MISSED_CALL_SMS_SCRIPT?: string;
  HUBSPOT_ACCESS_TOKEN?: string;
  INTERNAL_AUTH_KEY?: string;
  INTERNAL_INBOX_PASSWORD?: string;
  SESSION_SECRET?: string;
  ALLOWED_ORIGIN?: string;
  GTM_ADMIN_KEY?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  FALLBACK_AGENT_NUMBER?: string;
  FALLBACK_NUMBER?: string;
  GTM_DRY_RUN?: string;
  GTM_FROM_EMAIL?: string;
  GTM_FROM_NAME?: string;
  GTM_MAX_TOUCHES?: string;
  SMTP_HOST?: string;
  SMTP_PASS?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CLIENT_SECRET?: string;
  GRAPH_MAILBOX_UPN?: string;
};

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    internalSession: InternalSession;
  };
};

interface RuntimeDependencies {
  gtmServiceFactory?: (
    bindings: Parameters<typeof createRuntimeGtmService>[0]
  ) => ReturnType<typeof createRuntimeGtmService>;
  inboxProviderFactory?: (bindings: Bindings) => InternalInboxProvider;
  sessionStoreFactory?: (env: Bindings) => InternalSessionStore;
  userStoreFactory?: (env: Bindings) => InternalUserStore;
}

const routerLog = createLogger('[ROUTER]', 'router');
const GTM_APPROVAL_SMS_SUMMARY_LIMIT = 56;
const GTM_INTERNAL_OPERATOR_PHONE = '+12179912895';

const REQUIRED_BINDINGS = [
  'FALLBACK_AGENT_NUMBER',
  'FALLBACK_NUMBER',
  'HUBSPOT_ACCESS_TOKEN',
  'DB',
] as const;

type RequiredBindingName = (typeof REQUIRED_BINDINGS)[number];

class MissingBindingError extends Error {
  bindingName: RequiredBindingName;

  constructor(bindingName: RequiredBindingName) {
    super(`Missing required binding: ${bindingName}`);
    this.name = 'MissingBindingError';
    this.bindingName = bindingName;
  }
}

function validateRequiredBindings(env: Bindings): void {
  for (const bindingName of REQUIRED_BINDINGS) {
    const value = env[bindingName];
    const missing =
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim().length === 0);

    if (missing) {
      throw new MissingBindingError(bindingName);
    }
  }
}

function isInternalRequestAuthorized(c: Context<AppEnv>): boolean {
  const expectedAuthKey = c.env.INTERNAL_AUTH_KEY?.trim();
  if (!expectedAuthKey) {
    return false;
  }

  const authorization = c.req.header('Authorization');
  if (authorization === `Bearer ${expectedAuthKey}`) {
    return true;
  }

  const internalKeyHeader = c.req.header('x-internal-key');
  return internalKeyHeader === expectedAuthKey;
}

function shouldSkipStartupValidation(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return isProtectedInternalOperatorRoute(pathname);
}

function isLocalGtmTestEnvironment(env: Bindings): boolean {
  const environment = env.ENVIRONMENT?.trim().toLowerCase();
  return environment === 'development' || environment === 'local';
}

function isInternalAuthInfrastructureError(error: string): boolean {
  return (
    error.startsWith('ALLOWED_ORIGIN') ||
    error.startsWith('Internal session store') ||
    error.startsWith('Internal user store') ||
    error.startsWith('SESSION_SECRET') ||
    error.startsWith('SYSTEMIX_NUMBER') ||
    error.startsWith('INTERNAL_INBOX_PASSWORD') ||
    error.startsWith('Failed to create internal session') ||
    error.startsWith('Failed to read internal session') ||
    error.startsWith('Failed to delete internal session') ||
    error.startsWith('Failed to create internal user') ||
    error.startsWith('Failed to read internal user') ||
    error.startsWith('Failed to count internal owners') ||
    error.startsWith('Internal session store returned invalid session data') ||
    error.startsWith('Internal user store returned invalid user data')
  );
}

function isProtectedInternalOperatorRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/v1/internal/auth/') ||
    pathname.startsWith('/v1/internal/inbox/') ||
    pathname.startsWith('/v1/internal/gtm/')
  );
}

function resolveSessionStore(
  env: Bindings,
  dependencies: RuntimeDependencies
): AuthResult<InternalSessionStore> {
  if (dependencies.sessionStoreFactory) {
    return {
      ok: true,
      value: dependencies.sessionStoreFactory(env),
    };
  }

  return createInternalSessionStore(env);
}

function resolveUserStore(
  env: Bindings,
  dependencies: RuntimeDependencies
): AuthResult<InternalUserStore> {
  if (dependencies.userStoreFactory) {
    return {
      ok: true,
      value: dependencies.userStoreFactory(env),
    };
  }

  return createInternalUserStore(env);
}

function resolveRequestedRole(value: unknown, fallbackRole: InternalUserRole): AuthResult<InternalUserRole> {
  if (value === undefined || value === null || value === '') {
    return {
      ok: true,
      value: fallbackRole,
    };
  }

  if (value === 'owner' || value === 'operator') {
    return {
      ok: true,
      value,
    };
  }

  return {
    ok: false,
    error: 'role must be owner or operator',
  };
}

type GtmApprovalNotificationTarget = {
  businessNumber: string;
  displayName: string;
  ownerPhone: string;
};

function normalizeApprovalSummary(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= GTM_APPROVAL_SMS_SUMMARY_LIMIT) {
    return normalized;
  }

  return normalized.slice(0, GTM_APPROVAL_SMS_SUMMARY_LIMIT - 3).trimEnd() + '...';
}

function resolveApprovalNotificationSenderNumber(
  env: Pick<Bindings, 'TWILIO_PHONE_NUMBER' | 'SYSTEMIX_NUMBER'>,
  target: Pick<GtmApprovalNotificationTarget, 'businessNumber'>
): string {
  return (
    normalizePhone(env.TWILIO_PHONE_NUMBER || '') ||
    normalizePhone(env.SYSTEMIX_NUMBER || '') ||
    target.businessNumber
  );
}

function readLeadBusinessNumber(lead: ApprovalNotificationRequest['lead']): string | null {
  const metadata = lead.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const candidate =
    typeof metadata.businessNumber === 'string'
      ? metadata.businessNumber
      : typeof metadata.business_number === 'string'
        ? metadata.business_number
        : null;

  return normalizePhone(candidate || '');
}

async function findActiveBusinessByNumber(
  env: Pick<Bindings, 'SYSTEMIX'>,
  businessNumber: string
): Promise<GtmApprovalNotificationTarget | null> {
  const normalizedBusinessNumber = normalizePhone(businessNumber);
  if (!normalizedBusinessNumber) {
    return null;
  }

  const row = await env.SYSTEMIX
    .prepare(
      `
      SELECT business_number, owner_phone_number, display_name
      FROM businesses
      WHERE business_number = ?
        AND is_active = 1
      LIMIT 1
    `
    )
    .bind(normalizedBusinessNumber)
    .first<{ business_number?: string; owner_phone_number?: string | null; display_name?: string | null }>();

  if (!row?.business_number) {
    return null;
  }

  const ownerPhone = normalizePhone(row.owner_phone_number || '');
  if (!ownerPhone) {
    return null;
  }

  return {
    businessNumber: normalizePhone(row.business_number) || normalizedBusinessNumber,
    displayName: (row.display_name || '').trim() || 'Systemix',
    ownerPhone,
  };
}

async function findActiveBusinessByOwnerPhone(
  env: Pick<Bindings, 'SYSTEMIX'>,
  ownerPhone: string
): Promise<GtmApprovalNotificationTarget | null> {
  const normalizedOwnerPhone = normalizePhone(ownerPhone);
  if (!normalizedOwnerPhone) {
    return null;
  }

  const row = await env.SYSTEMIX
    .prepare(
      `
      SELECT business_number, owner_phone_number, display_name
      FROM businesses
      WHERE owner_phone_number = ?
        AND is_active = 1
      ORDER BY updated_at DESC
      LIMIT 1
    `
    )
    .bind(normalizedOwnerPhone)
    .first<{ business_number?: string; owner_phone_number?: string | null; display_name?: string | null }>();

  if (!row?.business_number) {
    return null;
  }

  return {
    businessNumber: normalizePhone(row.business_number) || '',
    displayName: (row.display_name || '').trim() || 'Systemix',
    ownerPhone: normalizedOwnerPhone,
  };
}

async function findSingleActiveBusiness(
  env: Pick<Bindings, 'SYSTEMIX'>
): Promise<GtmApprovalNotificationTarget | null> {
  const rows = await env.SYSTEMIX
    .prepare(
      `
      SELECT business_number, owner_phone_number, display_name
      FROM businesses
      WHERE is_active = 1
      LIMIT 2
    `
    )
    .all<{
      business_number?: string;
      owner_phone_number?: string | null;
      display_name?: string | null;
    }>();

  if (!Array.isArray(rows.results) || rows.results.length !== 1) {
    return null;
  }

  const row = rows.results[0];
  const businessNumber = normalizePhone(row.business_number || '');
  const ownerPhone = normalizePhone(row.owner_phone_number || '');
  if (!businessNumber || !ownerPhone) {
    return null;
  }

  return {
    businessNumber,
    displayName: (row.display_name || '').trim() || 'Systemix',
    ownerPhone,
  };
}

export async function resolveGtmApprovalNotificationTarget(
  env: Pick<Bindings, 'SYSTEMIX' | 'SYSTEMIX_NUMBER' | 'TWILIO_PHONE_NUMBER' | 'GTM_FROM_NAME'>,
  input: ApprovalNotificationRequest
): Promise<GtmApprovalNotificationTarget | null> {
  void input;

  const senderNumber =
    normalizePhone(env.TWILIO_PHONE_NUMBER || '') || normalizePhone(env.SYSTEMIX_NUMBER || '');
  if (!senderNumber) {
    return null;
  }

  return {
    businessNumber: senderNumber,
    displayName: env.GTM_FROM_NAME?.trim() || 'Systemix GTM',
    ownerPhone: GTM_INTERNAL_OPERATOR_PHONE,
  };
}

export function buildGtmApprovalSmsBody(
  target: Pick<GtmApprovalNotificationTarget, 'displayName'>,
  input: ApprovalNotificationRequest
): string {
  const businessLabel = target.displayName.trim() || 'Systemix';
  const leadLabel = input.lead.id.trim() || 'unknown-lead';
  const touchNumber = input.preparedAction.stage.stageIndex + 1;
  const summary = normalizeApprovalSummary(input.preparedAction.subject || input.preparedAction.body);
  const approvalCode = input.approval.approval_code;

  return (
    `Systemix approval ${approvalCode}. ${businessLabel}, lead ${leadLabel}, ` +
    `touch ${touchNumber}. ${summary}. Reply YES ${approvalCode} or NO ${approvalCode}.`
  );
}

export function createRuntimeGtmApprovalHooks(
  env: Bindings
): GTMServiceApprovalHooks {
  return {
    async requestApproval(input: ApprovalNotificationRequest): Promise<void> {
      const target = await resolveGtmApprovalNotificationTarget(env, input);
      if (!target) {
        throw new Error('GTM approval notification target is not configured');
      }

      const twilioClient = createTwilioRestClient(env);
      if (!twilioClient) {
        throw new Error('Twilio approval notification client is unavailable');
      }

      const body = buildGtmApprovalSmsBody(target, input);
      const senderNumber = resolveApprovalNotificationSenderNumber(env, target);
      const sendResult = await twilioClient.sendSms({
        toPhone: target.ownerPhone,
        fromPhone: senderNumber,
        businessNumber: target.businessNumber,
        body,
        skipOptOutCheck: true,
        skipIgnoredNumberCheck: true,
      });

      if (!sendResult.ok) {
        routerLog.error('GTM approval SMS failed', {
          context: {
            handler: 'createRuntimeGtmApprovalHooks',
            fromNumber: senderNumber,
            toNumber: target.ownerPhone,
          },
          data: {
            system: 'gtm',
            environment: env.ENVIRONMENT ?? 'unset',
            approvalCode: input.approval.approval_code,
            approvalId: input.approval.id,
            leadId: input.lead.id,
            stageIndex: input.preparedAction.stage.stageIndex,
            messageSid: sendResult.sid || null,
            detail: sendResult.detail || 'unknown',
          },
        });
        throw new Error(sendResult.detail || 'Failed to send GTM approval SMS');
      }

      if (sendResult.suppressed) {
        routerLog.error('GTM approval SMS suppressed', {
          context: {
            handler: 'createRuntimeGtmApprovalHooks',
            fromNumber: senderNumber,
            toNumber: target.ownerPhone,
          },
          data: {
            system: 'gtm',
            environment: env.ENVIRONMENT ?? 'unset',
            approvalCode: input.approval.approval_code,
            approvalId: input.approval.id,
            leadId: input.lead.id,
            stageIndex: input.preparedAction.stage.stageIndex,
            messageSid: sendResult.sid || null,
          },
        });
        throw new Error('GTM approval SMS was suppressed');
      }

      routerLog.log('GTM approval SMS sent', {
        context: {
          handler: 'createRuntimeGtmApprovalHooks',
          fromNumber: senderNumber,
          toNumber: target.ownerPhone,
        },
        data: {
          system: 'gtm',
          environment: env.ENVIRONMENT ?? 'unset',
          approvalCode: input.approval.approval_code,
          approvalId: input.approval.id,
          leadId: input.lead.id,
          stageIndex: input.preparedAction.stage.stageIndex,
          messageSid: sendResult.sid || null,
        },
      });
    },
  };
}

type GtmApprovalProofRow = {
  approval_code: string;
  status: string;
  requested_at: string;
  notified_at: string | null;
};

function isGtmLiveProofAuthorized(c: Context<AppEnv>): boolean {
  const expectedKey = c.env.GTM_LIVE_TEST_KEY?.trim();
  if (!expectedKey) {
    return false;
  }

  return c.req.header('x-gtm-live-test-key') === expectedKey;
}

async function getLatestGtmApprovalForLead(
  database: D1Database,
  leadId: string
): Promise<GtmApprovalProofRow | null> {
  const row = await database
    .prepare(
      `
      SELECT approval_code, status, requested_at, notified_at
      FROM gtm_approvals
      WHERE lead_id = ?
      ORDER BY requested_at DESC
      LIMIT 1
    `
    )
    .bind(leadId)
    .first<GtmApprovalProofRow>();

  return row ?? null;
}

function applyInternalCorsHeaders(c: Context<AppEnv>): AuthResult<void> {
  const corsHeadersResult = resolveInternalCorsHeaders(c.req.raw, c.env);
  if (!corsHeadersResult.ok) {
    return corsHeadersResult;
  }

  if (corsHeadersResult.value === null) {
    return {
      ok: true,
      value: undefined,
    };
  }

  for (const [headerName, headerValue] of Object.entries(corsHeadersResult.value)) {
    c.header(headerName, headerValue);
  }

  return {
    ok: true,
    value: undefined,
  };
}

function createInternalCorsMiddleware() {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const corsPolicyResult = resolveInternalCorsPolicy(c.req.raw, c.env);
    if (!corsPolicyResult.ok) {
      routerLog.error('Internal CORS configuration missing', {
        context: {
          handler: 'internalCorsMiddleware',
        },
        data: {
          error: corsPolicyResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    if (corsPolicyResult.value.requestOrigin !== null && !corsPolicyResult.value.isAllowedOrigin) {
      return new Response(null, {
        status: 403,
        headers: {
          Vary: 'Origin',
        },
      });
    }

    const corsHeadersResult = applyInternalCorsHeaders(c);
    if (!corsHeadersResult.ok) {
      routerLog.error('Internal CORS configuration missing', {
        context: {
          handler: 'internalCorsMiddleware',
        },
        data: {
          error: corsHeadersResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: c.res.headers });
    }

    await next();
  };
}

const productionOnlyStripeWebhookHandler = async (c: Context<AppEnv>) => {
  if (c.env.ENVIRONMENT !== 'production') {
    routerLog.log('Stripe webhook route disabled outside production', {
      context: {
        handler: 'productionOnlyStripeWebhookHandler',
      },
      data: {
        environment: c.env.ENVIRONMENT ?? 'unset',
      },
    });
    return c.text('Not found', 404);
  }

  return stripeWebhookHandler(c as unknown as Parameters<typeof stripeWebhookHandler>[0]);
};

function createInternalMiddleware(dependencies: RuntimeDependencies) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const pathname = new URL(c.req.url).pathname;
    if (!isProtectedInternalOperatorRoute(pathname)) {
      await next();
      return;
    }

    if (
      (pathname === '/v1/internal/auth/login' || pathname === '/v1/internal/auth/bootstrap') &&
      c.req.method === 'POST'
    ) {
      await next();
      return;
    }

    const sessionStoreResult = resolveSessionStore(c.env, dependencies);
    if (!sessionStoreResult.ok) {
      routerLog.error('Internal session store unavailable', {
        context: {
          handler: 'internalMiddleware',
        },
        data: {
          error: sessionStoreResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const userStoreResult = resolveUserStore(c.env, dependencies);
    if (!userStoreResult.ok) {
      routerLog.error('Internal user store unavailable', {
        context: {
          handler: 'internalMiddleware',
        },
        data: {
          error: userStoreResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const sessionResult = await getInternalSessionWithStore(
      c.req.raw,
      c.env,
      sessionStoreResult.value,
      userStoreResult.value
    );
    if (sessionResult.ok) {
      c.set('internalSession', sessionResult.value);
      await next();
      return;
    }

    if (isInternalAuthInfrastructureError(sessionResult.error)) {
      routerLog.error('Internal session validation failed', {
        context: {
          handler: 'internalMiddleware',
        },
        data: {
          error: sessionResult.error,
          pathname,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    // AUTH_REPLACE_LATER: Keep the GTM admin header only as a temporary non-browser fallback for curl access.
    if (pathname.startsWith('/v1/internal/gtm/replies') && isLegacyGtmAdminAuthorized(c.req.raw, c.env)) {
      await next();
      return;
    }

    if (pathname === '/v1/internal/auth/me') {
      return c.json({ authenticated: false }, 401);
    }

    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  };
}

export function createApp(dependencies: RuntimeDependencies = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.use('/v1/internal/*', createInternalCorsMiddleware());
  app.use('/v1/internal/*', createInternalMiddleware(dependencies));

  // Minimal durable internal auth: bootstrap first owner from the legacy shared password, then use user-based sessions.
  app.post('/v1/internal/auth/bootstrap', async (c) => {
    if (!isInternalRequestAuthorized(c)) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    let payload: {
      username?: string;
      displayName?: string;
      businessNumber?: string;
    };

    try {
      payload = (await c.req.json()) as {
        username?: string;
        displayName?: string;
        businessNumber?: string;
      };
    } catch {
      payload = {};
    }

    const userStoreResult = resolveUserStore(c.env, dependencies);
    if (!userStoreResult.ok) {
      routerLog.error('Internal user store unavailable during bootstrap', {
        context: {
          handler: 'internalAuthBootstrap',
        },
        data: {
          error: userStoreResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const bootstrapResult = await createBootstrapOwner(userStoreResult.value, c.env, {
      username: payload.username,
      displayName: payload.displayName,
      businessNumber: payload.businessNumber,
    });

    if (!bootstrapResult.ok) {
      if (bootstrapResult.error === 'Owner already exists') {
        return c.json({ ok: false, error: bootstrapResult.error }, 409);
      }

      if (
        bootstrapResult.error.startsWith('Username') ||
        bootstrapResult.error.startsWith('Display name') ||
        bootstrapResult.error.startsWith('businessNumber')
      ) {
        return c.json({ ok: false, error: bootstrapResult.error }, 400);
      }

      if (isInternalAuthInfrastructureError(bootstrapResult.error)) {
        return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
      }

      return c.json({ ok: false, error: bootstrapResult.error }, 400);
    }

    return c.json(
      {
        ok: true,
        user: {
          id: bootstrapResult.value.id,
          businessNumber: bootstrapResult.value.businessNumber,
          username: bootstrapResult.value.username,
          displayName: bootstrapResult.value.displayName,
          role: bootstrapResult.value.role,
        },
      },
      201
    );
  });

  app.post('/v1/internal/auth/login', async (c) => {
    let payload: {
      username?: string;
      password?: string;
    };

    try {
      payload = (await c.req.json()) as {
        username?: string;
        password?: string;
      };
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const username = typeof payload.username === 'string' ? payload.username : '';
    const password = typeof payload.password === 'string' ? payload.password : '';

    const userStoreResult = resolveUserStore(c.env, dependencies);
    if (!userStoreResult.ok) {
      routerLog.error('Internal user store unavailable during login', {
        context: {
          handler: 'internalAuthLogin',
        },
        data: {
          error: userStoreResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const userResult = await authenticateInternalUser(userStoreResult.value, {
      username,
      password,
    });
    if (!userResult.ok) {
      if (userResult.error === 'User inactive') {
        return c.json({ ok: false, error: 'User inactive' }, 403);
      }

      if (userResult.error === 'Invalid credentials') {
        return c.json({ ok: false, error: 'Invalid credentials' }, 401);
      }

      routerLog.error('Internal user authentication failed', {
        context: {
          handler: 'internalAuthLogin',
        },
        data: {
          error: userResult.error,
          username,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const sessionStoreResult = resolveSessionStore(c.env, dependencies);
    if (!sessionStoreResult.ok) {
      routerLog.error('Internal session store unavailable during login', {
        context: {
          handler: 'internalAuthLogin',
        },
        data: {
          error: sessionStoreResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const sessionResult = await createInternalSession(c.req.raw, c.env, sessionStoreResult.value, {
      userId: userResult.value.id,
      role: userResult.value.role,
      businessNumber: userResult.value.businessNumber,
    });
    if (!sessionResult.ok) {
      routerLog.error('Internal session creation failed', {
        context: {
          handler: 'internalAuthLogin',
        },
        data: {
          error: sessionResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    c.header('Set-Cookie', sessionResult.value.cookieHeader);
    return c.json({ ok: true }, 200);
  });

  // AUTH_REPLACE_LATER: Temporary session introspection endpoint for the internal Lovable inbox shell.
  app.get('/v1/internal/auth/me', (c) => {
    const session = c.get('internalSession');
    return c.json(
      {
        authenticated: true,
        expiresAt: session.expiresAt,
        user: {
          id: session.user.id,
          businessNumber: session.user.businessNumber,
          username: session.user.username,
          displayName: session.user.displayName,
          role: session.user.role,
        },
      },
      200
    );
  });

  app.post('/v1/internal/auth/users', async (c) => {
    const session = c.get('internalSession');
    if (session.role !== 'owner') {
      return c.json({ ok: false, error: 'Forbidden' }, 403);
    }

    let payload: {
      username?: string;
      displayName?: string;
      password?: string;
      role?: string;
    };

    try {
      payload = (await c.req.json()) as {
        username?: string;
        displayName?: string;
        password?: string;
        role?: string;
      };
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const usernameResult = normalizeInternalUsername(typeof payload.username === 'string' ? payload.username : '');
    if (!usernameResult.ok) {
      return c.json({ ok: false, error: usernameResult.error }, 400);
    }

    const displayNameResult = normalizeInternalDisplayName(
      typeof payload.displayName === 'string' ? payload.displayName : ''
    );
    if (!displayNameResult.ok) {
      return c.json({ ok: false, error: displayNameResult.error }, 400);
    }

    const roleResult = resolveRequestedRole(payload.role, 'operator');
    if (!roleResult.ok) {
      return c.json({ ok: false, error: roleResult.error }, 400);
    }

    const businessNumberResult = normalizeInternalBusinessNumber(session.businessNumber);
    if (!businessNumberResult.ok) {
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const password = typeof payload.password === 'string' ? payload.password : '';
    const userStoreResult = resolveUserStore(c.env, dependencies);
    if (!userStoreResult.ok) {
      routerLog.error('Internal user store unavailable during user creation', {
        context: {
          handler: 'internalAuthCreateUser',
        },
        data: {
          error: userStoreResult.error,
          ownerUserId: session.userId,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const createUserResult = await createInternalUserAccount(userStoreResult.value, {
      businessNumber: businessNumberResult.value,
      username: usernameResult.value,
      displayName: displayNameResult.value,
      role: roleResult.value,
      password,
    });

    if (!createUserResult.ok) {
      if (
        createUserResult.error.startsWith('Username') ||
        createUserResult.error.startsWith('Display name') ||
        createUserResult.error.startsWith('Password')
      ) {
        return c.json({ ok: false, error: createUserResult.error }, 400);
      }

      if (createUserResult.error === 'Username already exists') {
        return c.json({ ok: false, error: createUserResult.error }, 409);
      }

      routerLog.error('Internal user creation failed', {
        context: {
          handler: 'internalAuthCreateUser',
        },
        data: {
          error: createUserResult.error,
          ownerUserId: session.userId,
          username: usernameResult.value,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    return c.json(
      {
        ok: true,
        user: {
          id: createUserResult.value.id,
          businessNumber: createUserResult.value.businessNumber,
          username: createUserResult.value.username,
          displayName: createUserResult.value.displayName,
          role: createUserResult.value.role,
        },
      },
      201
    );
  });

  app.post('/v1/internal/auth/logout', async (c) => {
    const sessionStoreResult = resolveSessionStore(c.env, dependencies);
    if (!sessionStoreResult.ok) {
      routerLog.error('Internal session store unavailable during logout', {
        context: {
          handler: 'internalAuthLogout',
        },
        data: {
          error: sessionStoreResult.error,
        },
      });
      return c.json({ ok: false, error: 'Internal auth unavailable' }, 500);
    }

    const clearCookieResult = await clearInternalSession(c.req.raw, c.env, sessionStoreResult.value);
    if (!clearCookieResult.ok) {
      routerLog.error('Internal session logout failed', {
        context: {
          handler: 'internalAuthLogout',
        },
        data: {
          error: clearCookieResult.error,
        },
      });
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    c.header('Set-Cookie', clearCookieResult.value);
    return c.json({ ok: true }, 200);
  });

  app.post('/v1/internal/onboard', async (c) => {
    if (!isInternalRequestAuthorized(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let payload: {
      business_number?: string;
      owner_phone_number?: string;
      display_name?: string;
      intake_question?: string;
    };

    try {
      payload = (await c.req.json()) as {
        business_number?: string;
        owner_phone_number?: string;
        display_name?: string;
        intake_question?: string;
      };
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const business_number = typeof payload.business_number === 'string' ? payload.business_number.trim() : '';
    const owner_phone_number =
      typeof payload.owner_phone_number === 'string' ? payload.owner_phone_number.trim() : '';
    const display_name = typeof payload.display_name === 'string' ? payload.display_name.trim() : '';
    const intake_question = typeof payload.intake_question === 'string' ? payload.intake_question.trim() : '';

    if (!business_number || !owner_phone_number || !display_name) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    scheduleTwilioBackgroundTask(
      c.executionCtx,
      'Manual onboard',
      upsertBusiness(
        {
          business_number,
          owner_phone_number,
          display_name,
          intake_question: intake_question || null,
        },
        c.env
      ).then(() =>
        routerLog.log('Manual onboard complete', {
          context: {
            handler: 'internalOnboard',
            fromNumber: business_number,
            toNumber: owner_phone_number,
          },
          data: {
            displayName: display_name,
          },
        })
      )
    );

    return c.json({ success: true }, 200);
  });

  app.post('/v1/internal/missed-call/ignore-number', async (c) => {
    if (!isInternalRequestAuthorized(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let payload: {
      phone_number?: string;
    };

    try {
      payload = (await c.req.json()) as {
        phone_number?: string;
      };
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const phoneNumber = typeof payload.phone_number === 'string' ? payload.phone_number.trim() : '';
    if (!phoneNumber) {
      return c.json({ error: 'phone_number is required' }, 400);
    }

    const businessNumber =
      normalizePhone(c.req.header('x-business-number') || '') ||
      normalizePhone(new URL(c.req.url).searchParams.get('business_number') || '');

    if (!businessNumber) {
      return c.json({ error: 'business_number scope is required' }, 400);
    }

    await ensureCustomerMissedCallSchema(c.env.SYSTEMIX);
    await ignoreMissedCallNumber(c.env.SYSTEMIX, {
      businessNumber,
      phoneNumber,
    });

    return c.json(
      {
        success: true,
        business_number: businessNumber,
        phone_number: normalizePhone(phoneNumber) || phoneNumber,
        ignored: true,
      },
      200
    );
  });

  app.get('/v1/internal/missed-call/stats', async (c) => {
    if (!isInternalRequestAuthorized(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await ensureCustomerMissedCallSchema(c.env.SYSTEMIX);
    const stats = await getMissedCallRecoveryStats(c.env.SYSTEMIX);

    return c.json(
      {
        success: true,
        recovered_opportunity_definition: RECOVERED_OPPORTUNITY_DEFINITION,
        totals: {
          missed_calls: stats.totalMissedCalls,
          customer_replies: stats.totalCustomerReplies,
          recovered_opportunities: stats.totalRecoveredOpportunities,
        },
      },
      200
    );
  });

  app.post('/v1/internal/gtm/send-test-email', async (c) => {
    if (!isInternalRequestAuthorized(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!isLocalGtmTestEnvironment(c.env)) {
      return c.json({ error: 'Not found' }, 404);
    }

    let payload: {
      confirmLiveSend?: boolean;
      toEmail?: string;
    };

    try {
      payload = (await c.req.json()) as {
        confirmLiveSend?: boolean;
        toEmail?: string;
      };
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const toEmail = typeof payload.toEmail === 'string' ? payload.toEmail.trim() : '';
    if (!toEmail) {
      return c.json({ error: 'toEmail is required' }, 400);
    }

    const configResult = resolveGtmConfigFromEnv(c.env);
    if (!configResult.ok) {
      return c.json({ error: configResult.error }, 400);
    }

    if (!configResult.value.dryRun && payload.confirmLiveSend !== true) {
      return c.json({ error: 'confirmLiveSend must be true when GTM_DRY_RUN is false' }, 400);
    }

    const sendResult = await sendGtmTestEmail(configResult.value, c.env, toEmail);
    if (!sendResult.ok) {
      return c.json({ error: sendResult.error }, 502);
    }

    return c.json(
      {
        success: true,
        ...sendResult.value,
      },
      200
    );
  });

  app.post('/v1/gtm/live-proof', async (c) => {
    if (!isGtmLiveProofAuthorized(c)) {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    if (!c.env.GTM_DB) {
      return c.json({ ok: false, error: 'GTM_DB is not configured' }, 500);
    }

    const service = gtmServiceFactory(c.env as Parameters<typeof createRuntimeGtmService>[0]);
    const timestamp = new Date().toISOString();
    const compactTimestamp = timestamp.replace(/\D/g, '').slice(0, 14);
    const leadId = `gtm-live-proof-${compactTimestamp}`;

    routerLog.log('GTM live proof route invoked', {
      context: {
        handler: 'gtmLiveProofRoute',
      },
      data: {
        system: 'gtm',
        environment: c.env.ENVIRONMENT ?? 'unset',
        leadId,
      },
    });

    const lead = {
      id: leadId,
      name: 'Jordan GTM Proof',
      email: `${leadId}@example.com`,
      phone: '+13125550199',
      createdAt: timestamp,
      metadata: {
        source: 'gtm_live_proof_route',
      },
    };

    const createLeadResult = await service.createLead(lead);
    if (!createLeadResult.ok) {
      return c.json({ ok: false, error: createLeadResult.error, leadId }, 400);
    }

    const startSequenceResult = await service.startSequence(leadId);
    if (!startSequenceResult.ok) {
      return c.json({ ok: false, error: startSequenceResult.error, leadId }, 400);
    }

    const advanceResult = await service.advanceLeadSequence(leadId);
    if (!advanceResult.ok) {
      return c.json({ ok: false, error: advanceResult.error, leadId }, 400);
    }

    const resultLeadId = advanceResult.value.leadId || leadId;
    const approval = await getLatestGtmApprovalForLead(c.env.GTM_DB, resultLeadId);

    routerLog.log('GTM live proof route completed', {
      context: {
        handler: 'gtmLiveProofRoute',
      },
      data: {
        system: 'gtm',
        environment: c.env.ENVIRONMENT ?? 'unset',
        leadId: resultLeadId,
        action: advanceResult.value.action,
        reason: advanceResult.value.reason ?? null,
        approvalCode: approval?.approval_code ?? null,
        approvalStatus: approval?.status ?? null,
        notifiedAt: approval?.notified_at ?? null,
      },
    });

    return c.json(
      {
        ok: true,
        leadId: resultLeadId,
        action: advanceResult.value.action,
        reason: advanceResult.value.reason ?? null,
        approvalCode: approval?.approval_code ?? null,
      },
      200
    );
  });

  const gtmServiceFactory =
    dependencies.gtmServiceFactory ??
    ((bindings: Parameters<typeof createRuntimeGtmService>[0]) =>
      createRuntimeGtmService(bindings, {
        approvalHooks: createRuntimeGtmApprovalHooks(bindings as Bindings),
      }));

  app.route(
    '/',
    createInternalInboxHandler((bindings) =>
      dependencies.inboxProviderFactory
        ? dependencies.inboxProviderFactory(bindings as Bindings)
        : new D1InternalInboxProvider(bindings)
    )
  );

  app.route(
    '/',
    createGtmInternalFlowHandler((bindings) =>
      gtmServiceFactory(bindings as Parameters<typeof createRuntimeGtmService>[0])
    )
  );

  app.route(
    '/',
    createGtmInternalRepliesHandler((bindings) =>
      gtmServiceFactory(bindings as Parameters<typeof createRuntimeGtmService>[0])
    )
  );

  // PHASE 1: Answer the phone quickly.
  app.post('/v1/webhooks/twilio/voice', twilioVoiceHandler);
  app.post('/voice', twilioVoiceHandler);

  // PHASE 2: Recording callback persists transcript and notifies owner.
  app.post('/dial-status', twilioDialStatusHandler);
  app.post('/voicemail-transcription', twilioVoicemailTranscriptionHandler);
  app.post('/v1/webhooks/twilio/recording', twilioRecordingHandler);
  app.post('/recording', twilioRecordingHandler);

  // Call status callback: sends customer welcome SMS for completed/no-answer/busy calls.
  app.post('/v1/webhooks/twilio/status', twilioStatusHandler);
  app.post('/status', twilioStatusHandler);

  // Inbound SMS: forward lead response to owner.
  app.post('/v1/webhooks/twilio/sms', twilioSmsHandler);

  // Stripe webhook: create HubSpot company on completed checkout.
  app.post('/v1/webhooks/stripe', productionOnlyStripeWebhookHandler);
  app.post('/webhooks/stripe', productionOnlyStripeWebhookHandler);

  // Testing endpoint (disabled in production in handler).
  app.post('/test/simulate-callback', simulateCallbackHandler);

  return app;
}

export function createWorker(dependencies: RuntimeDependencies = {}): ExportedHandler<Bindings> {
  const app = createApp(dependencies);

  return {
    async fetch(request, env, executionCtx) {
      if (!shouldSkipStartupValidation(request)) {
        try {
          validateRequiredBindings(env);
        } catch (error) {
          if (error instanceof MissingBindingError) {
            routerLog.error('Startup validation failed', {
              error,
              context: {
                handler: 'fetch',
              },
              data: {
                missingBinding: error.bindingName,
              },
            });
            return new Response(error.message, {
              status: 500,
              headers: {
                'Content-Type': 'text/plain; charset=UTF-8',
              },
            });
          }

          routerLog.error('Unexpected startup validation error', {
            error,
            context: {
              handler: 'fetch',
            },
          });
          return new Response('startup_validation_failed', {
            status: 500,
            headers: {
              'Content-Type': 'text/plain; charset=UTF-8',
            },
          });
        }
      }

      return app.fetch(request, env, executionCtx);
    },
    scheduled(_controller, env, ctx) {
      scheduleTwilioBackgroundTask(
        ctx,
        'Emergency timeout check',
        checkEmergencyTimeouts(env).catch((error) => {
          routerLog.error('Emergency timeout scheduled check failed', {
            error,
            context: {
              handler: 'scheduled',
            },
          });
          throw error;
        })
      );
    },
  };
}

const worker = createWorker();

export default worker;

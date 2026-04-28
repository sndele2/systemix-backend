// @ts-nocheck
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { hashInternalPassword } from './core/internal-auth.ts';
import {
  buildGtmApprovalSmsBody,
  createRuntimeGtmAgentHooks,
  createRuntimeGtmApprovalHooks,
  createWorker,
  resolveGtmApprovalNotificationTarget,
} from './index.ts';

const executionCtx = {
  passThroughOnException() {},
  waitUntil() {},
};

class MockSessionStore {
  constructor() {
    this.sessions = new Map();
    this.deletedSessionIds = [];
  }

  async createSession(session) {
    this.sessions.set(session.id, { ...session });
    return { ok: true, value: undefined };
  }

  async getSession(sessionId) {
    return {
      ok: true,
      value: this.sessions.get(sessionId) ?? null,
    };
  }

  async deleteSession(sessionId) {
    this.deletedSessionIds.push(sessionId);
    this.sessions.delete(sessionId);
    return { ok: true, value: undefined };
  }
}

class MockUserStore {
  constructor() {
    this.usersById = new Map();
    this.userIdsByUsername = new Map();
    this.createdCount = 0;
  }

  async seedUser({
    id,
    username,
    displayName,
    role = 'owner',
    businessNumber = '+18443217137',
    password = 'operator-secret',
    isActive = true,
  }) {
    const passwordHashResult = await hashInternalPassword(password);
    assert.equal(passwordHashResult.ok, true);

    const userId = id ?? `user-${this.createdCount + 1}`;
    const normalizedUsername = username.toLowerCase();
    const timestamp = '2026-04-18T18:00:00.000Z';
    const user = {
      id: userId,
      businessNumber,
      username: normalizedUsername,
      displayName,
      role,
      passwordHash: passwordHashResult.value,
      isActive,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.createdCount += 1;
    this.usersById.set(user.id, user);
    this.userIdsByUsername.set(user.username, user.id);
    return user;
  }

  async countOwners() {
    return {
      ok: true,
      value: Array.from(this.usersById.values()).filter((user) => user.role === 'owner' && user.isActive)
        .length,
    };
  }

  async createUser(input) {
    if (this.userIdsByUsername.has(input.username)) {
      return { ok: false, error: 'Username already exists' };
    }

    const timestamp = '2026-04-18T18:00:00.000Z';
    const user = {
      id: `user-${this.createdCount + 1}`,
      businessNumber: input.businessNumber,
      username: input.username,
      displayName: input.displayName,
      role: input.role,
      passwordHash: input.passwordHash,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.createdCount += 1;
    this.usersById.set(user.id, user);
    this.userIdsByUsername.set(user.username, user.id);
    return {
      ok: true,
      value: {
        id: user.id,
        businessNumber: user.businessNumber,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        isActive: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  }

  async getUserById(userId) {
    const user = this.usersById.get(userId);
    if (!user) {
      return { ok: true, value: null };
    }

    return {
      ok: true,
      value: {
        id: user.id,
        businessNumber: user.businessNumber,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }

  async getUserByUsername(username) {
    const userId = this.userIdsByUsername.get(username.toLowerCase());
    if (!userId) {
      return { ok: true, value: null };
    }

    return this.getUserById(userId);
  }

  async getUserRecordByUsername(username) {
    const userId = this.userIdsByUsername.get(username.toLowerCase());
    if (!userId) {
      return { ok: true, value: null };
    }

    return {
      ok: true,
      value: this.usersById.get(userId),
    };
  }
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

class MockApprovalPreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.boundArgs = [];
  }

  bind(...args) {
    this.boundArgs = args;
    return this;
  }

  async first() {
    return this.db.handleFirst(this.sql, this.boundArgs);
  }

  async all() {
    return this.db.handleAll(this.sql, this.boundArgs);
  }

  async run() {
    return this.db.handleRun(this.sql, this.boundArgs);
  }
}

class MockApprovalDatabase {
  constructor({ businesses = [], approvals = [] } = {}) {
    this.businesses = businesses;
    this.approvals = approvals;
  }

  prepare(sql) {
    return new MockApprovalPreparedStatement(this, sql);
  }

  async handleFirst(sql, args) {
    const normalized = normalizeSql(sql);

    if (normalized.includes('from businesses') && normalized.includes('where business_number = ?')) {
      const businessNumber = args[0];
      return this.businesses.find((row) => row.business_number === businessNumber && row.is_active === 1) ?? null;
    }

    if (normalized.includes('from businesses') && normalized.includes('where owner_phone_number = ?')) {
      const ownerPhone = args[0];
      return this.businesses.find((row) => row.owner_phone_number === ownerPhone && row.is_active === 1) ?? null;
    }

    if (normalized.includes('from sms_opt_outs')) {
      return null;
    }

    if (normalized.includes('from missed_call_ignored_numbers')) {
      return null;
    }

    if (normalized.includes('from gtm_approvals') && normalized.includes('where lead_id = ?')) {
      const leadId = args[0];
      return this.approvals.find((row) => row.lead_id === leadId) ?? null;
    }

    return null;
  }

  async handleAll(sql) {
    const normalized = normalizeSql(sql);

    if (normalized.includes('from businesses') && normalized.includes('where is_active = 1')) {
      return {
        results: this.businesses.filter((row) => row.is_active === 1).slice(0, 2),
      };
    }

    return { results: [] };
  }

  async handleRun() {
    return {
      meta: {
        changes: 1,
      },
    };
  }
}

function createGtmServiceStub(overrides = {}) {
  return {
    async createLead() {
      return {
        ok: true,
        value: undefined,
      };
    },
    async startSequence() {
      return {
        ok: true,
        value: undefined,
      };
    },
    async advanceLeadSequence() {
      return {
        ok: true,
        value: {
          action: 'skipped',
          leadId: 'lead-internal-1',
          reason: 'awaiting_approval',
        },
      };
    },
    async syncAndListReplies() {
      return {
        ok: true,
        value: {
          synced_at: '2026-04-18T18:00:00.000Z',
          new_replies_found: 1,
          replies: [
            {
              id: 'reply-1',
              lead_id: 'lead-1',
              from_email: 'lead@example.com',
              subject: 'Re: missed call',
              body_snippet: 'Please call me back.',
              received_at: '2026-04-18T17:59:00.000Z',
              conversation_id: 'conversation-1',
              classification: 'reply_detected',
              sequence_stopped: true,
              raw_provider_id: 'reply-1',
              created_at: '2026-04-18T17:59:01.000Z',
            },
          ],
        },
      };
    },
    async listRepliesForLead() {
      return {
        ok: true,
        value: {
          synced_at: '2026-04-18T18:00:00.000Z',
          new_replies_found: 0,
          replies: [],
        },
      };
    },
    ...overrides,
  };
}

function createEnv(overrides = {}) {
  return {
    ALLOWED_ORIGIN: 'https://systemix.lovable.app',
    GTM_DB: {},
    SYSTEMIX: {},
    INTERNAL_INBOX_PASSWORD: 'operator-secret',
    SESSION_SECRET: 'temporary-session-secret-that-is-long-enough',
    SYSTEMIX_NUMBER: '+18443217137',
    TWILIO_ACCOUNT_SID: 'twilio-account',
    TWILIO_AUTH_TOKEN: 'twilio-token',
    TWILIO_PHONE_NUMBER: '+18443217137',
    ...overrides,
  };
}

function createTestWorker(sessionStore, userStore, overrides = {}) {
  return createWorker({
    gtmServiceFactory: () => createGtmServiceStub(overrides.gtmServiceOverrides),
    sessionStoreFactory: () => sessionStore,
    userStoreFactory: () => userStore,
  });
}

function getSessionCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'expected a Set-Cookie header');
  return setCookie.split(';')[0];
}

async function loginAndCaptureCookie(worker, env, overrides = {}) {
  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: env.ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        username: 'owner',
        password: 'operator-secret',
        ...overrides,
      }),
    }),
    env,
    executionCtx
  );

  return {
    response,
    cookie: response.headers.get('set-cookie') ? getSessionCookie(response) : null,
  };
}

test('bootstrap creates the first owner from the legacy password seed', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv({
    INTERNAL_AUTH_KEY: 'internal-secret',
  });

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer internal-secret',
        Origin: env.ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        username: 'owner',
        displayName: 'Systemix Owner',
      }),
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    user: {
      id: 'user-1',
      businessNumber: '+18443217137',
      username: 'owner',
      displayName: 'Systemix Owner',
      role: 'owner',
    },
  });
});

test('login with correct username and password returns 200 and sets the signed session cookie', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();

  const { response, cookie } = await loginAndCaptureCookie(worker, env);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const createdSession = Array.from(sessionStore.sessions.values())[0];

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.ok(cookie.startsWith('sessionId='));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=None/);
  assert.equal(response.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(createdSession.userId, 'user-1');
  assert.equal(createdSession.role, 'owner');
  assert.equal(createdSession.businessNumber, '+18443217137');
});

test('login with wrong password returns 401', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();

  const { response } = await loginAndCaptureCookie(worker, env, {
    password: 'wrong-password',
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Invalid credentials',
  });
  assert.equal(sessionStore.sessions.size, 0);
});

test('login with an inactive user returns 403', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
    isActive: false,
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();

  const { response } = await loginAndCaptureCookie(worker, env);

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'User inactive',
  });
});

test('GET /v1/internal/auth/me returns authenticated user details for a valid session', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();
  const { cookie } = await loginAndCaptureCookie(worker, env);

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/me', {
      headers: {
        Cookie: cookie,
        Origin: env.ALLOWED_ORIGIN,
      },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    authenticated: true,
    expiresAt: Array.from(sessionStore.sessions.values())[0].expiresAt,
    user: {
      id: 'user-1',
      businessNumber: '+18443217137',
      username: 'owner',
      displayName: 'Systemix Owner',
      role: 'owner',
    },
  });
});

test('GET /v1/internal/auth/me returns 401 for an expired session', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();
  const { cookie } = await loginAndCaptureCookie(worker, env);
  const sessionId = Array.from(sessionStore.sessions.keys())[0];

  sessionStore.sessions.set(sessionId, {
    ...sessionStore.sessions.get(sessionId),
    expiresAt: '2026-04-18T00:00:00.000Z',
  });

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/me', {
      headers: {
        Cookie: cookie,
        Origin: env.ALLOWED_ORIGIN,
      },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { authenticated: false });
});

test('GET /v1/internal/auth/me returns 401 with no cookie', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/me', {
      headers: {
        Origin: env.ALLOWED_ORIGIN,
      },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { authenticated: false });
});

test('owner sessions can create operator users with separate passwords', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();
  const { cookie } = await loginAndCaptureCookie(worker, env);

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer internal-secret',
        Cookie: cookie,
        Origin: env.ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        username: 'operator-1',
        displayName: 'Operator One',
        password: 'operator-1-secret',
        role: 'operator',
      }),
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    user: {
      id: 'user-2',
      businessNumber: '+18443217137',
      username: 'operator-1',
      displayName: 'Operator One',
      role: 'operator',
    },
  });
});

test('operator sessions cannot create additional users', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'operator-1',
    displayName: 'Operator One',
    role: 'operator',
    password: 'operator-1-secret',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();
  const { cookie } = await loginAndCaptureCookie(worker, env, {
    username: 'operator-1',
    password: 'operator-1-secret',
  });

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: env.ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        username: 'blocked-user',
        displayName: 'Blocked User',
        password: 'blocked-user-secret',
      }),
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Forbidden',
  });
});

test('protected GTM replies route passes through with a valid session cookie', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();
  const { cookie } = await loginAndCaptureCookie(worker, env);

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/replies?matched_only=true', {
      headers: {
        Cookie: cookie,
        Origin: env.ALLOWED_ORIGIN,
      },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.new_replies_found, 1);
  assert.equal(json.replies.length, 1);
});

test('protected GTM replies route returns 401 with no cookie', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/replies', {
      headers: {
        Origin: env.ALLOWED_ORIGIN,
      },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'Unauthorized',
  });
});

test('logout deletes the session and clears the cookie', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();
  const { cookie } = await loginAndCaptureCookie(worker, env);
  const createdSessionId = Array.from(sessionStore.sessions.keys())[0];

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: env.ALLOWED_ORIGIN,
      },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sessionStore.sessions.size, 0);
  assert.deepEqual(sessionStore.deletedSessionIds, [createdSessionId]);
  assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.match(response.headers.get('set-cookie') ?? '', /SameSite=None/);
});

test('OPTIONS preflight returns 204 with the internal CORS headers', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/inbox/conversations', {
      method: 'OPTIONS',
      headers: {
        Origin: env.ALLOWED_ORIGIN,
      },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(
    response.headers.get('access-control-allow-headers'),
    'Content-Type, X-GTM-Admin-Key'
  );
});

test('non-cookie internal routes also return credentialed CORS headers for the allowed origin', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv({
    FALLBACK_AGENT_NUMBER: '+12175550111',
    FALLBACK_NUMBER: '+12175550112',
    HUBSPOT_ACCESS_TOKEN: 'hubspot-token',
    DB: {},
  });

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/onboard', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: env.ALLOWED_ORIGIN,
      },
      body: JSON.stringify({}),
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('internal preflight rejects origins that do not exactly match ALLOWED_ORIGIN', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv();

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
      },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('vary'), 'Origin');
});

test('internal GTM test route still requires header auth outside the cookie middleware scope', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({
    username: 'owner',
    displayName: 'Systemix Owner',
  });
  const worker = createTestWorker(sessionStore, userStore);
  const env = createEnv({
    ENVIRONMENT: 'local',
    FALLBACK_AGENT_NUMBER: '+12175550111',
    FALLBACK_NUMBER: '+12175550112',
    HUBSPOT_ACCESS_TOKEN: 'hubspot-token',
    DB: {},
    INTERNAL_AUTH_KEY: 'internal-secret',
    GTM_DRY_RUN: 'true',
    SMTP_USER: 'mailbox@example.com',
  });
  const { cookie } = await loginAndCaptureCookie(worker, env);

  const unauthorizedResponse = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/send-test-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        toEmail: 'test-recipient@example.com',
      }),
    }),
    env,
    executionCtx
  );

  assert.equal(unauthorizedResponse.status, 401);
  assert.deepEqual(await unauthorizedResponse.json(), {
    ok: false,
    error: 'Unauthorized',
  });

  const authorizedResponse = await worker.fetch(
    new Request('http://example.com/v1/internal/gtm/send-test-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer internal-secret',
        Cookie: cookie,
        Origin: env.ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        toEmail: 'test-recipient@example.com',
      }),
    }),
    env,
    executionCtx
  );

  assert.equal(authorizedResponse.status, 200);
  const json = await authorizedResponse.json();
  assert.equal(json.success, true);
  assert.equal(json.dryRun, true);
});

test('GTM live proof route requires the dedicated live test key and returns approval details', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  const leadId = 'gtm-live-proof-20260422230000';
  const worker = createTestWorker(sessionStore, userStore, {
    gtmServiceOverrides: {
      async advanceLeadSequence() {
        return {
          ok: true,
          value: {
            action: 'skipped',
            leadId,
            reason: 'awaiting_approval',
          },
        };
      },
    },
  });
  const env = createEnv({
    GTM_LIVE_TEST_KEY: 'proof-key',
    FALLBACK_AGENT_NUMBER: '+12175550111',
    FALLBACK_NUMBER: '+12175550112',
    HUBSPOT_ACCESS_TOKEN: 'hubspot-token',
    DB: {},
    GTM_DB: new MockApprovalDatabase({
      approvals: [
        {
          approval_code: 'ABC12345',
          lead_id: leadId,
          subject: 'Agent subject',
          body: 'Agent body for the finalized GTM proposal.',
          status: 'pending',
          requested_at: '2026-04-22T23:00:00.000Z',
          notified_at: '2026-04-22T23:00:01.000Z',
        },
      ],
    }),
  });

  const unauthorizedResponse = await worker.fetch(
    new Request('http://example.com/v1/gtm/live-proof', {
      method: 'POST',
    }),
    env,
    executionCtx
  );

  assert.equal(unauthorizedResponse.status, 401);
  assert.deepEqual(await unauthorizedResponse.json(), {
    ok: false,
    error: 'Unauthorized',
  });

  const authorizedResponse = await worker.fetch(
    new Request('http://example.com/v1/gtm/live-proof', {
      method: 'POST',
      headers: {
        'x-gtm-live-test-key': 'proof-key',
      },
    }),
    env,
    executionCtx
  );

  assert.equal(authorizedResponse.status, 200);
  const json = await authorizedResponse.json();
  assert.equal(json.ok, true);
  assert.equal(json.action, 'skipped');
  assert.equal(json.reason, 'awaiting_approval');
  assert.equal(json.approvalCode, 'ABC12345');
  assert.equal(json.proposalSubject, 'Agent subject');
  assert.equal(json.proposalBody, 'Agent body for the finalized GTM proposal.');
  assert.match(json.leadId, /^gtm-live-proof-/);
});

test('createRuntimeGtmAgentHooks wires only the outreach writer runner', async () => {
  const calls = [];
  const hooks = createRuntimeGtmAgentHooks(
    {
      OPENAI_API_KEY: 'openai-key',
      GTM_AGENT_MODEL: 'gtm-model',
    },
    async (input, options) => {
      calls.push({ input, options });
      return {
        subject: 'Agent-built GTM subject',
        body: 'Agent-built GTM body about missed revenue.',
        variantLabel: 'test-agent',
      };
    }
  );

  assert.equal(typeof hooks.writeOutreach, 'function');
  assert.equal(hooks.reviewLead, undefined);
  assert.equal(hooks.interpretReply, undefined);

  const output = await hooks.writeOutreach(
    {
      id: 'lead-123',
      name: 'Test Roofing',
      email: 'owner@testroofing.example',
      phone: '+13125550199',
      createdAt: '2026-04-22T23:00:00.000Z',
      status: 'active',
      touches_sent: 0,
      metadata: {
        source: 'manual_gtm',
        city: 'Chicago',
        industry: 'roofing',
      },
    },
    {
      stageIndex: 0,
      delayHours: 0,
      templateKey: 'missed-call-touch-1',
    }
  );

  assert.equal(output.subject, 'Agent-built GTM subject');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.apiKey, 'openai-key');
  assert.equal(calls[0].options.model, 'gtm-model');
  assert.equal(calls[0].input.candidate.businessName, 'Test Roofing');
  assert.equal(calls[0].input.candidate.city, 'Chicago');
  assert.equal(calls[0].input.outreachAngle, 'lost_jobs_recovery');
});

test('customer-facing recovery routes do not import GTM agents', () => {
  const recoveryRouteFiles = [
    new URL('./webhooks/twilioVoice.ts', import.meta.url),
    new URL('./webhooks/twilioStatus.ts', import.meta.url),
    new URL('./webhooks/twilioSms.ts', import.meta.url),
    new URL('./services/missedCallRecovery.ts', import.meta.url),
    new URL('./services/processCall.ts', import.meta.url),
  ];

  for (const fileUrl of recoveryRouteFiles) {
    const source = readFileSync(fileUrl, 'utf8');
    assert.doesNotMatch(source, /gtm\/agents|agents\/runner|outreach-writer/);
  }
});

test('buildGtmApprovalSmsBody is decision-first and uses the finalized proposal', () => {
  const body = buildGtmApprovalSmsBody(
    {
      displayName: 'Test Roofer',
    },
    {
      approval: {
        id: 'approval-1',
        approval_code: 'ABC12345',
        proposal_hash: 'gtm-hash-1',
        status: 'pending',
        body: 'Stored approval body should not replace the current finalized preview.',
      },
      lead: {
        id: 'lead-full-id-should-not-appear',
        name: 'Jordan',
        metadata: {
          niche: 'mobile detailing',
          approvalRationale: 'likely misses calls while on jobs',
        },
      },
      preparedAction: {
        action: 'send',
        stage: {
          stageIndex: 1,
        },
        subject: 'Jordan, wanted to follow up on the missed call and open job',
        body: 'Finalized GTM proposal body from the writer.',
      },
    }
  );

  assert.match(body, /ABC12345/);
  assert.match(body, /Jordan - mobile detailing/);
  assert.match(body, /Why: likely misses calls while on jobs/);
  assert.match(body, /"Finalized GTM proposal body from the writer."/);
  assert.match(body, /YES ABC12345 \/ NO ABC12345/);
  assert.doesNotMatch(body, /Systemix approval|Systemix GTM|lead-full-id-should-not-appear|Test Roofer|touch 2/);
});

test('resolveGtmApprovalNotificationTarget fails closed to the fixed GTM operator number', async () => {
  const env = createEnv({
    SYSTEMIX: new MockApprovalDatabase({
      businesses: [
        {
          business_number: '+18001234567',
          owner_phone_number: '+12179912895',
          display_name: 'Test Roofer',
          is_active: 1,
        },
      ],
    }),
  });

  const target = await resolveGtmApprovalNotificationTarget(env, {
    approval: {
      id: 'approval-1',
      approval_code: 'ABC12345',
      proposal_hash: 'gtm-hash-1',
      status: 'pending',
    },
    lead: {
      id: 'lead-123',
      name: 'Jordan',
      metadata: {},
    },
    preparedAction: {
      action: 'send',
      stage: {
        stageIndex: 0,
      },
      subject: 'Jordan, wanted to follow up on your missed call',
    },
  });

  assert.deepEqual(target, {
    businessNumber: '+18443217137',
    displayName: 'Systemix GTM',
    ownerPhone: '+12179912895',
  });
});

test('createRuntimeGtmApprovalHooks sends an approval SMS through the runtime twilio client', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];

  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    return new Response(JSON.stringify({ sid: 'SM_APPROVAL_1' }), {
      status: 201,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  };

  try {
    const env = createEnv({
      SYSTEMIX: new MockApprovalDatabase({
        businesses: [
          {
            business_number: '+18001234567',
            owner_phone_number: '+12179912895',
            display_name: 'Test Roofer',
            is_active: 1,
          },
        ],
      }),
    });

    const hooks = createRuntimeGtmApprovalHooks(env);
    await hooks.requestApproval({
      approval: {
        id: 'approval-1',
        approval_code: 'ABC12345',
        proposal_hash: 'gtm-hash-1',
        status: 'pending',
        body: 'Stored approval body.',
      },
      lead: {
        id: 'lead-123',
        name: 'Jordan',
        metadata: {
          industry: 'roofing',
          rationale: 'new inbound calls need quick capture',
        },
      },
      preparedAction: {
        action: 'send',
        stage: {
          stageIndex: 0,
        },
        subject: 'Jordan, wanted to follow up on your missed call',
        body: 'Actual finalized outbound body for approval.',
      },
    });

    assert.equal(fetchCalls.length, 1);
    assert.match(String(fetchCalls[0].url), /Messages\.json/);
    assert.match(String(fetchCalls[0].init.body), /To=%2B12179912895/);
    assert.match(String(fetchCalls[0].init.body), /From=%2B18443217137/);
    assert.match(String(fetchCalls[0].init.body), /Jordan\+-\+roofing/);
    assert.match(String(fetchCalls[0].init.body), /Actual\+finalized\+outbound\+body\+for\+approval/);
    assert.match(String(fetchCalls[0].init.body), /YES\+ABC12345\+%2F\+NO\+ABC12345/);
    assert.doesNotMatch(String(fetchCalls[0].init.body), /Systemix\+approval|Systemix\+GTM/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

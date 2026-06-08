// @ts-nocheck
/**
 * Auth/inbox ACCEPTANCE tests — v3 RUN 1.
 *
 * Pass conditions are the criteria CONFIRMED with the operator at Gate 1 (not authored
 * here by the builder):
 *   AC1  login with valid credentials -> 200 and sets the session cookie with the exact
 *        attributes HttpOnly; Secure; SameSite=None; Path=/; Max-Age.
 *   AC2  GET /auth/me with that cookie -> 200 { authenticated: true, user... }.
 *   AC3  GET /v1/internal/inbox/conversations with that cookie -> 200 and the inbox loads
 *        for the authed operator (provider invoked, scoped to the session businessNumber).
 *   AC4  unauthed (no cookie) -> 401 AND the inbox provider is NOT invoked (the auth gate
 *        is actually exercised, not bypassed).
 *   AC5  cross-origin request from a non-allowed Origin -> 403, no ACAO, provider NOT
 *        invoked (credentialed-CORS exact-origin enforcement).
 *
 * SCOPE NOTE: these validate the SERVER-SIDE auth contract only. They do NOT exercise
 * browser third-party-cookie behaviour (hypothesis H1) — that is a property of the
 * browser, not the Worker, and can only be settled by a live cross-site browser login.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { hashInternalPassword } from './core/internal-auth.ts';
import { createWorker } from './index.ts';

const ALLOWED_ORIGIN = 'https://systemixai.co'; // exact production dashboard origin confirmed in Phase 1
const BUSINESS_NUMBER = '+18443217137';

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
    return { ok: true, value: this.sessions.get(sessionId) ?? null };
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
    username,
    displayName,
    role = 'owner',
    businessNumber = BUSINESS_NUMBER,
    password = 'operator-secret-1',
    isActive = true,
  }) {
    const passwordHashResult = await hashInternalPassword(password);
    assert.equal(passwordHashResult.ok, true, 'seed password must hash');
    const id = `user-${this.createdCount + 1}`;
    const timestamp = '2026-04-20T03:13:56.939Z';
    const user = {
      id,
      businessNumber,
      username: username.toLowerCase(),
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
      value: Array.from(this.usersById.values()).filter((u) => u.role === 'owner' && u.isActive).length,
    };
  }

  async createUser() {
    return { ok: false, error: 'not used in acceptance tests' };
  }

  async getUserById(userId) {
    const user = this.usersById.get(userId);
    if (!user) return { ok: true, value: null };
    const { passwordHash: _passwordHash, ...rest } = user;
    return { ok: true, value: rest };
  }

  async getUserByUsername(username) {
    const userId = this.userIdsByUsername.get(username.toLowerCase());
    if (!userId) return { ok: true, value: null };
    return this.getUserById(userId);
  }

  async getUserRecordByUsername(username) {
    const userId = this.userIdsByUsername.get(username.toLowerCase());
    if (!userId) return { ok: true, value: null };
    return { ok: true, value: this.usersById.get(userId) };
  }
}

function createInboxProviderStub() {
  const calls = { listConversations: [], getConversation: [], replyToConversation: [] };
  const provider = {
    async listConversations(businessNumber, limit) {
      calls.listConversations.push({ businessNumber, limit });
      return {
        ok: true,
        value: [
          {
            id: `${BUSINESS_NUMBER}:+12175550123`,
            businessNumber: BUSINESS_NUMBER,
            contact: { phoneNumber: '+12175550123' },
            source: 'sms',
            preview: 'Please call me back.',
            updatedAt: '2026-04-20T12:00:00.000Z',
          },
        ],
      };
    },
    async getConversation() {
      return { ok: true, value: null };
    },
    async replyToConversation() {
      return { ok: true, value: undefined };
    },
  };
  return { provider, calls };
}

function createEnv(overrides = {}) {
  return {
    ALLOWED_ORIGIN,
    SYSTEMIX: {},
    GTM_DB: {},
    INTERNAL_INBOX_PASSWORD: 'operator-secret-1',
    SESSION_SECRET: 'temporary-session-secret-that-is-long-enough',
    SYSTEMIX_NUMBER: BUSINESS_NUMBER,
    TWILIO_ACCOUNT_SID: 'twilio-account',
    TWILIO_AUTH_TOKEN: 'twilio-token',
    TWILIO_PHONE_NUMBER: BUSINESS_NUMBER,
    ...overrides,
  };
}

function createTestWorker(sessionStore, userStore, inboxProvider) {
  return createWorker({
    sessionStoreFactory: () => sessionStore,
    userStoreFactory: () => userStore,
    inboxProviderFactory: () => inboxProvider,
  });
}

async function login(worker, env, overrides = {}) {
  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ username: 'owner', password: 'operator-secret-1', ...overrides }),
    }),
    env,
    executionCtx
  );
  const setCookie = response.headers.get('set-cookie');
  return { response, setCookie, cookie: setCookie ? setCookie.split(';')[0] : null };
}

test('AC1: valid login returns 200 and sets a cookie with HttpOnly; Secure; SameSite=None; Path=/; Max-Age', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({ username: 'owner', displayName: 'Systemix Owner' });
  const { provider } = createInboxProviderStub();
  const worker = createTestWorker(sessionStore, userStore, provider);
  const env = createEnv();

  const { response, setCookie, cookie } = await login(worker, env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.ok(cookie.startsWith('sessionId='), 'cookie is the sessionId cookie');
  // Full cookie contract — the diagnosis hinged on these exact attributes.
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=None/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=\d+/);
  assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('AC2 + AC3: with the session cookie, /auth/me is authenticated AND the inbox loads for the operator', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({ username: 'owner', displayName: 'Systemix Owner' });
  const { provider, calls } = createInboxProviderStub();
  const worker = createTestWorker(sessionStore, userStore, provider);
  const env = createEnv();
  const { cookie } = await login(worker, env);

  // AC2 — /auth/me succeeds with the cookie
  const meResponse = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/me', {
      headers: { Cookie: cookie, Origin: ALLOWED_ORIGIN },
    }),
    env,
    executionCtx
  );
  assert.equal(meResponse.status, 200);
  const meJson = await meResponse.json();
  assert.equal(meJson.authenticated, true);
  assert.equal(meJson.user.username, 'owner');
  assert.equal(meJson.user.role, 'owner');

  // AC3 — inbox loads for the authed operator, scoped to the session businessNumber
  const inboxResponse = await worker.fetch(
    new Request('http://example.com/v1/internal/inbox/conversations?limit=25', {
      headers: { Cookie: cookie, Origin: ALLOWED_ORIGIN },
    }),
    env,
    executionCtx
  );
  assert.equal(inboxResponse.status, 200);
  const inboxJson = await inboxResponse.json();
  assert.equal(Array.isArray(inboxJson.conversations), true);
  assert.equal(inboxJson.conversations.length, 1);
  assert.deepEqual(calls.listConversations, [{ businessNumber: BUSINESS_NUMBER, limit: 25 }]);
});

test('AC4: unauthed inbox request returns 401 AND the provider is never invoked (gate is exercised)', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({ username: 'owner', displayName: 'Systemix Owner' });
  const { provider, calls } = createInboxProviderStub();
  const worker = createTestWorker(sessionStore, userStore, provider);
  const env = createEnv();

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/inbox/conversations', {
      headers: { Origin: ALLOWED_ORIGIN }, // allowed origin, but NO cookie
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: 'Unauthorized' });
  // The real assertion: the auth gate stopped the request BEFORE any data access.
  assert.deepEqual(calls.listConversations, [], 'inbox provider must not be called when unauthed');
});

test('AC5: a cookie presented from a non-allowed Origin is refused 403 with no ACAO, provider not invoked', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({ username: 'owner', displayName: 'Systemix Owner' });
  const { provider, calls } = createInboxProviderStub();
  const worker = createTestWorker(sessionStore, userStore, provider);
  const env = createEnv();
  const { cookie } = await login(worker, env);

  const response = await worker.fetch(
    new Request('http://example.com/v1/internal/inbox/conversations', {
      headers: { Cookie: cookie, Origin: 'https://evil.example' },
    }),
    env,
    executionCtx
  );

  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.deepEqual(calls.listConversations, [], 'cross-origin request must be refused before data access');
});

/**
 * AC6 + AC7 were added in response to the adversarial review (Step 5), which proved via
 * mutation testing that AC1-AC5 stay green even if HMAC signature verification or the
 * session-expiry check are removed. With src/index.test.ts currently failing to load
 * (finding F5 — stale GTM import), these two close the only runnable guard on those
 * checks. They are auth-hardening, exercising the real verification paths.
 */
test('AC6 (hardening): a real session id with a tampered HMAC signature is rejected 401, provider not invoked', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({ username: 'owner', displayName: 'Systemix Owner' });
  const { provider, calls } = createInboxProviderStub();
  const worker = createTestWorker(sessionStore, userStore, provider);
  const env = createEnv();
  const { cookie } = await login(worker, env); // "sessionId=<id>.<signature>"

  // Keep the REAL, stored session id; corrupt only the signature so the failure is
  // specifically the HMAC check (not a missing session). Same length, still hex.
  const [name, value] = cookie.split('=');
  const [sessionId, signature] = value.split('.');
  assert.ok(sessionStore.sessions.has(sessionId), 'precondition: session id exists in the store');
  const tamperedSig = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
  assert.notEqual(tamperedSig, signature);
  const forgedCookie = `${name}=${sessionId}.${tamperedSig}`;

  const meResponse = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/me', {
      headers: { Cookie: forgedCookie, Origin: ALLOWED_ORIGIN },
    }),
    env,
    executionCtx
  );
  assert.equal(meResponse.status, 401);
  assert.deepEqual(await meResponse.json(), { authenticated: false });

  const inboxResponse = await worker.fetch(
    new Request('http://example.com/v1/internal/inbox/conversations', {
      headers: { Cookie: forgedCookie, Origin: ALLOWED_ORIGIN },
    }),
    env,
    executionCtx
  );
  assert.equal(inboxResponse.status, 401);
  assert.deepEqual(calls.listConversations, [], 'a forged signature must not reach the inbox provider');
});

test('AC7 (hardening): an expired stored session is rejected 401 (and cleaned up) despite a validly-signed cookie', async () => {
  const sessionStore = new MockSessionStore();
  const userStore = new MockUserStore();
  await userStore.seedUser({ username: 'owner', displayName: 'Systemix Owner' });
  const { provider, calls } = createInboxProviderStub();
  const worker = createTestWorker(sessionStore, userStore, provider);
  const env = createEnv();
  const { cookie } = await login(worker, env);

  // Server-side expiry is authoritative: age the stored row into the past. The cookie is
  // unchanged and still validly signed, so this isolates the expiry check.
  const sessionId = Array.from(sessionStore.sessions.keys())[0];
  sessionStore.sessions.set(sessionId, {
    ...sessionStore.sessions.get(sessionId),
    expiresAt: '2000-01-01T00:00:00.000Z',
  });

  const meResponse = await worker.fetch(
    new Request('http://example.com/v1/internal/auth/me', {
      headers: { Cookie: cookie, Origin: ALLOWED_ORIGIN },
    }),
    env,
    executionCtx
  );
  assert.equal(meResponse.status, 401);
  assert.deepEqual(await meResponse.json(), { authenticated: false });
  assert.ok(
    sessionStore.deletedSessionIds.includes(sessionId),
    'an expired session must be deleted when it is accessed'
  );

  const inboxResponse = await worker.fetch(
    new Request('http://example.com/v1/internal/inbox/conversations', {
      headers: { Cookie: cookie, Origin: ALLOWED_ORIGIN },
    }),
    env,
    executionCtx
  );
  assert.equal(inboxResponse.status, 401);
  assert.deepEqual(calls.listConversations, [], 'an expired session must not reach the inbox provider');
});

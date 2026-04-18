import assert from 'node:assert/strict';
import test from 'node:test';
import { createTwilioRestClient, sendTwilioSms } from '../src/core/sms.ts';
import { buildMissedCallFollowUpMessage } from '../src/services/missedCallRecovery.ts';
import {
  buildSmsHelpMessage,
  buildSmsOptInConfirmationMessage,
  buildSmsOptOutConfirmationMessage,
  prepareCustomerFacingSmsBody,
  resolveInboundSmsComplianceAction,
  SMS_OPT_OUT_FOOTER,
} from '../src/services/smsCompliance.ts';
import { twilioSmsHandler } from '../src/webhooks/twilioSms.ts';

type MessageRow = {
  direction: string;
  provider: string;
  provider_message_id: string | null;
  from_phone: string;
  to_phone: string;
  body: string;
  raw_json: string;
};

class FakeStatement {
  private boundValues: unknown[] = [];
  private readonly db: FakeD1Database;
  private readonly sql: string;

  constructor(db: FakeD1Database, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]) {
    this.boundValues = values;
    return this;
  }

  async run() {
    return this.db.run(this.sql, this.boundValues);
  }

  async first<T>() {
    return this.db.first<T>(this.sql, this.boundValues);
  }

  async all<T>() {
    return this.db.all<T>(this.sql, this.boundValues);
  }
}

class FakeD1Database {
  readonly messages: MessageRow[] = [];
  readonly businesses = new Map<
    string,
    {
      business_number: string;
      owner_phone_number: string;
      display_name: string;
      is_active: number;
      intake_question?: string | null;
    }
  >();
  readonly smsOptOuts = new Map<string, { isOptedOut: boolean; createdAt: string; updatedAt: string }>();
  readonly missedCallIgnoredNumbers = new Set<string>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  private normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private optOutKey(businessNumber: string, phoneNumber: string): string {
    return `${businessNumber}|${phoneNumber}`;
  }

  async run(sql: string, boundValues: unknown[]) {
    const normalizedSql = this.normalizeSql(sql);

    if (
      normalizedSql.startsWith('create table') ||
      normalizedSql.startsWith('create unique index') ||
      normalizedSql.startsWith('create index') ||
      normalizedSql.startsWith('alter table')
    ) {
      return { meta: { changes: 0 } };
    }

    if (normalizedSql.startsWith('insert into messages')) {
      const direction = normalizedSql.includes("values (?, 'inbound'") ? 'inbound' : 'outbound';
      const provider = String(boundValues[1]);
      const hasExplicitProviderMessageIdColumn = boundValues.length === 7;
      const providerMessageId = hasExplicitProviderMessageIdColumn
        ? ((boundValues[2] as string | null | undefined) || null)
        : null;
      const fromPhone = String(boundValues[hasExplicitProviderMessageIdColumn ? 3 : 2]);
      const toPhone = String(boundValues[hasExplicitProviderMessageIdColumn ? 4 : 3]);
      const body = String(boundValues[hasExplicitProviderMessageIdColumn ? 5 : 4]);
      const rawJson = String(boundValues[hasExplicitProviderMessageIdColumn ? 6 : 5]);

      if (
        providerMessageId &&
        this.messages.some(
          (message) =>
            message.provider === provider &&
            message.provider_message_id === providerMessageId
        )
      ) {
        return { meta: { changes: 0 } };
      }

      this.messages.push({
        direction,
        provider,
        provider_message_id: providerMessageId,
        from_phone: fromPhone,
        to_phone: toPhone,
        body,
        raw_json: rawJson,
      });

      return { meta: { changes: 1 } };
    }

    if (normalizedSql.startsWith('insert into sms_opt_outs')) {
      const businessNumber = String(boundValues[1]);
      const phoneNumber = String(boundValues[2]);
      const isOptedOut = Number(boundValues[3]) === 1;
      const createdAt = String(boundValues[4]);
      const updatedAt = String(boundValues[5]);
      const key = this.optOutKey(businessNumber, phoneNumber);
      const existing = this.smsOptOuts.get(key);

      this.smsOptOuts.set(key, {
        isOptedOut,
        createdAt: existing?.createdAt || createdAt,
        updatedAt,
      });

      return { meta: { changes: 1 } };
    }

    if (normalizedSql.startsWith('insert into missed_call_ignored_numbers')) {
      const businessNumber = String(boundValues[1]);
      const phoneNumber = String(boundValues[2]);
      this.missedCallIgnoredNumbers.add(this.optOutKey(businessNumber, phoneNumber));
      return { meta: { changes: 1 } };
    }

    if (
      normalizedSql.startsWith('update missed_call_conversations set reply_received = 1') ||
      normalizedSql.startsWith('update missed_call_conversations set is_ignored = 1')
    ) {
      return { meta: { changes: 0 } };
    }

    throw new Error(`Unhandled run SQL in test fake: ${normalizedSql}`);
  }

  async first<T>(sql: string, boundValues: unknown[]): Promise<T | null> {
    const normalizedSql = this.normalizeSql(sql);

    if (normalizedSql.includes('select 1 as seen from messages')) {
      const provider = String(boundValues[0]);
      const providerMessageId = String(boundValues[1]);
      const seen = this.messages.some(
        (message) => message.provider === provider && message.provider_message_id === providerMessageId
      );
      return seen ? ({ seen: 1 } as T) : null;
    }

    if (normalizedSql.includes('select business_number, owner_phone_number, display_name from businesses')) {
      const businessNumber = String(boundValues[0]);
      const business = this.businesses.get(businessNumber);
      if (!business || business.is_active !== 1) {
        return null;
      }

      return {
        business_number: business.business_number,
        owner_phone_number: business.owner_phone_number,
        display_name: business.display_name,
      } as T;
    }

    if (
      normalizedSql.includes("select provider_message_id from messages") &&
      normalizedSql.includes("where direction = 'outbound'")
    ) {
      const fromPhone = String(boundValues[0]);
      const toPhone = String(boundValues[1]);
      const message = this.messages.find(
        (row) =>
          row.direction === 'outbound' &&
          row.provider === 'twilio' &&
          row.from_phone === fromPhone &&
          row.to_phone === toPhone
      );
      return message ? ({ provider_message_id: message.provider_message_id } as T) : null;
    }

    if (normalizedSql.includes('select is_opted_out from sms_opt_outs')) {
      const businessNumber = String(boundValues[0]);
      const phoneNumber = String(boundValues[1]);
      const record = this.smsOptOuts.get(this.optOutKey(businessNumber, phoneNumber));
      return record ? ({ is_opted_out: record.isOptedOut ? 1 : 0 } as T) : null;
    }

    if (normalizedSql.includes('select 1 as is_ignored from missed_call_ignored_numbers')) {
      const businessNumber = String(boundValues[0]);
      const phoneNumber = String(boundValues[1]);
      return this.missedCallIgnoredNumbers.has(this.optOutKey(businessNumber, phoneNumber))
        ? ({ is_ignored: 1 } as T)
        : null;
    }

    return null;
  }

  async all<T>(_sql: string, _boundValues: unknown[]): Promise<{ results: T[] }> {
    return { results: [] };
  }
}

function createContext(input: {
  env: Record<string, unknown>;
  form: Record<string, string>;
}) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(input.form)) {
    formData.set(key, value);
  }

  const waitUntilPromises: Promise<unknown>[] = [];

  const context = {
    env: input.env,
    req: {
      formData: async () => formData,
      url: 'https://example.com/v1/webhooks/twilio/sms',
      header: (_name: string) => undefined,
    },
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    body: (body: BodyInit | null, status = 200, headers?: Record<string, string>) =>
      new Response(body, {
        status,
        headers,
      }),
  };

  return {
    context: context as Parameters<typeof twilioSmsHandler>[0],
    waitUntilPromises,
  };
}

function buildEnv(db: FakeD1Database) {
  return {
    SYSTEMIX: db as unknown as D1Database,
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'auth-token',
    TWILIO_PHONE_NUMBER: '+18443217137',
    OPENAI_API_KEY: 'test-openai-key',
    TWILIO_SIGNATURE_MODE: 'off',
    ENVIRONMENT: 'development',
  };
}

function seedBusiness(db: FakeD1Database) {
  db.businesses.set('+18443217137', {
    business_number: '+18443217137',
    owner_phone_number: '+12175550111',
    display_name: 'Systemix Plumbing',
    is_active: 1,
  });
}

function installFetchStub() {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: string }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : '';

    requests.push({ url, body });

    if (url.includes('api.twilio.com')) {
      return new Response(JSON.stringify({ sid: `SM${requests.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('api.openai.com')) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"classification":"inquiry","summary":"Customer needs help.","confidence":"high"}',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    throw new Error(`Unexpected fetch request in test: ${url}`);
  }) as typeof fetch;

  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test('STOP is intercepted before AI, persists opt-out, and sends one confirmation', async () => {
  const db = new FakeD1Database();
  seedBusiness(db);
  const fetchStub = installFetchStub();

  try {
    const { context, waitUntilPromises } = createContext({
      env: buildEnv(db),
      form: {
        MessageSid: 'SMSTOP1',
        From: '+13125550199',
        To: '+18443217137',
        Body: '  stop  ',
      },
    });

    const response = await twilioSmsHandler(context);
    await Promise.all(waitUntilPromises);

    assert.equal(response.status, 200);
    assert.equal(
      db.smsOptOuts.get('+18443217137|+13125550199')?.isOptedOut,
      true
    );
    assert.equal(fetchStub.requests.length, 1);

    const twilioRequest = fetchStub.requests[0];
    const twilioBody = new URLSearchParams(twilioRequest.body);
    assert.equal(twilioBody.get('To'), '+13125550199');
    assert.equal(
      twilioBody.get('Body'),
      buildSmsOptOutConfirmationMessage('Systemix Plumbing', '+18443217137')
    );
    assert.equal(twilioBody.get('Body')?.includes(SMS_OPT_OUT_FOOTER), false);
    assert.equal(fetchStub.requests.some((request) => request.url.includes('api.openai.com')), false);
  } finally {
    fetchStub.restore();
  }
});

test('HELP is intercepted before AI and sends the compliance help response', async () => {
  const db = new FakeD1Database();
  seedBusiness(db);
  const fetchStub = installFetchStub();

  try {
    const { context, waitUntilPromises } = createContext({
      env: buildEnv(db),
      form: {
        MessageSid: 'SMHELP1',
        From: '+13125550199',
        To: '+18443217137',
        Body: 'help',
      },
    });

    await twilioSmsHandler(context);
    await Promise.all(waitUntilPromises);

    assert.equal(db.smsOptOuts.size, 0);
    assert.equal(fetchStub.requests.length, 1);

    const twilioBody = new URLSearchParams(fetchStub.requests[0].body);
    assert.equal(
      twilioBody.get('Body'),
      buildSmsHelpMessage('Systemix Plumbing', '+18443217137')
    );
    assert.equal(fetchStub.requests.some((request) => request.url.includes('api.openai.com')), false);
  } finally {
    fetchStub.restore();
  }
});

test('START clears an existing opt-out and sends one opt-in confirmation', async () => {
  const db = new FakeD1Database();
  seedBusiness(db);
  db.smsOptOuts.set('+18443217137|+13125550199', {
    isOptedOut: true,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  });
  const fetchStub = installFetchStub();

  try {
    const { context, waitUntilPromises } = createContext({
      env: buildEnv(db),
      form: {
        MessageSid: 'SMSTART1',
        From: '+13125550199',
        To: '+18443217137',
        Body: 'start',
      },
    });

    await twilioSmsHandler(context);
    await Promise.all(waitUntilPromises);

    assert.equal(
      db.smsOptOuts.get('+18443217137|+13125550199')?.isOptedOut,
      false
    );
    assert.equal(fetchStub.requests.length, 1);
    assert.equal(
      new URLSearchParams(fetchStub.requests[0].body).get('Body'),
      buildSmsOptInConfirmationMessage()
    );
  } finally {
    fetchStub.restore();
  }
});

test('centralized suppression blocks opted-out sends for both Twilio client paths', async () => {
  const db = new FakeD1Database();
  const env = buildEnv(db);
  db.smsOptOuts.set('+18443217137|+13125550199', {
    isOptedOut: true,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  });
  const fetchStub = installFetchStub();

  try {
    const client = createTwilioRestClient(env);
    assert.ok(client);

    const clientResult = await client.sendSms({
      toPhone: '+13125550199',
      fromPhone: '+18443217137',
      businessNumber: '+18443217137',
      body: 'Outbound message',
    });

    assert.equal(clientResult.ok, true);
    assert.equal(clientResult.suppressed, true);

    await sendTwilioSms(env, '+13125550199', 'Second outbound message', {
      businessNumber: '+18443217137',
    });

    assert.equal(fetchStub.requests.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test('centralized suppression blocks ignored-number sends for Twilio client paths', async () => {
  const db = new FakeD1Database();
  const env = buildEnv(db);
  db.missedCallIgnoredNumbers.add('+18443217137|+13125550199');
  const fetchStub = installFetchStub();

  try {
    const client = createTwilioRestClient(env);
    assert.ok(client);

    const clientResult = await client.sendSms({
      toPhone: '+13125550199',
      fromPhone: '+18443217137',
      businessNumber: '+18443217137',
      body: 'Outbound message',
    });

    assert.equal(clientResult.ok, true);
    assert.equal(clientResult.suppressed, true);
    assert.equal(clientResult.detail, 'suppressed_ignored');

    await sendTwilioSms(env, '+13125550199', 'Second outbound message', {
      businessNumber: '+18443217137',
    });

    assert.equal(fetchStub.requests.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test('footer utility appends once, avoids duplication, and STOP confirmation stays footer-free', async () => {
  const db = new FakeD1Database();

  const firstOutbound = await prepareCustomerFacingSmsBody(
    db as unknown as D1Database,
    '+18443217137',
    '+13125550199',
    'We got your message.'
  );
  const duplicatedFooter = await prepareCustomerFacingSmsBody(
    db as unknown as D1Database,
    '+18443217137',
    '+13125550200',
    `We got your message.\n\n${SMS_OPT_OUT_FOOTER}\n\n${SMS_OPT_OUT_FOOTER}`
  );

  assert.equal(firstOutbound.endsWith(SMS_OPT_OUT_FOOTER), true);
  assert.equal((duplicatedFooter.match(/Reply STOP to opt out\./g) || []).length, 1);
  assert.equal(
    buildSmsOptOutConfirmationMessage('Systemix Plumbing', '+18443217137').includes(SMS_OPT_OUT_FOOTER),
    false
  );
});

test('missed-call follow-up message uses the configured intake question with a safe fallback', () => {
  assert.equal(
    buildMissedCallFollowUpMessage('what package were you interested in?'),
    'Hey — saw you tried calling. Was this about a car detail? If so, what package were you interested in?'
  );
  assert.equal(
    buildMissedCallFollowUpMessage(''),
    'Hey — saw you tried calling. Was this about a car detail? If so, what vehicle and service were you looking for?'
  );
});

test('non-command inbound messages are not intercepted by the compliance gate', () => {
  assert.equal(resolveInboundSmsComplianceAction('My basement is flooding'), null);
  assert.equal(resolveInboundSmsComplianceAction('schedule me for tomorrow'), null);
});

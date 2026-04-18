import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildTwilioValidationUrl } from '../src/core/twilioSignature.ts';
import { appendSmsOptOutFooter, SMS_OPT_OUT_FOOTER } from '../src/core/sms.ts';
import { createLogger } from '../src/core/logging.ts';
import { classifyLeadIntent } from '../src/services/openai.ts';
import { prepareCustomerFacingSmsBody } from '../src/services/smsCompliance.ts';
import {
  buildBusinessOwnerAlertMessage,
  buildEmergencyPriorityMessage,
  formatDisplayPhoneNumber,
  buildOwnerAlertMessage,
  findBusinessByNumber,
  MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER,
  MISSED_CALL_VOICE_HOOK_MESSAGE,
  shouldFireMissedCallVoiceHook,
} from '../src/services/twilioLaunch.ts';
import { twilioVoiceHandler } from '../src/webhooks/twilioVoice.ts';

const verifyLog = createLogger('[ONBOARD]', 'verify-v1-final-polish');

type FakeRow = Record<string, unknown> | null;

class FakeStatement {
  sql: string;
  row: FakeRow;
  lastBindings: unknown[] = [];
  db: FakeDb;

  constructor(db: FakeDb, sql: string, row: FakeRow) {
    this.db = db;
    this.sql = sql;
    this.row = row;
  }

  bind(...values: unknown[]) {
    this.lastBindings = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.resolveFirst(this.sql, this.lastBindings) as T | null) ?? (this.row as T | null) ?? null;
  }

  async run(): Promise<{ meta?: { changes?: number } }> {
    return this.db.resolveRun(this.sql, this.lastBindings);
  }
}

class FakeDb {
  lastStatement: FakeStatement | null = null;
  row: FakeRow;
  outboundMessages = new Map<string, string>();
  calls = new Map<string, { customer_welcome_sent_at: string | null; customer_welcome_message_id: string | null }>();
  leads: Array<{ phone: string; details: string }> = [];
  businesses = new Map<string, { business_number: string; display_name: string | null }>();

  constructor(row: FakeRow) {
    this.row = row;
  }

  prepare(sql: string) {
    this.lastStatement = new FakeStatement(this, sql, this.row);
    return this.lastStatement;
  }

  resolveFirst(sql: string, bindings: unknown[]): FakeRow {
    if (sql.includes('FROM businesses') && sql.includes('WHERE business_number = ?')) {
      const businessNumber = String(bindings[0] || '');
      return this.businesses.get(businessNumber) || null;
    }

    if (sql.includes('FROM messages') && sql.includes("direction = 'outbound'")) {
      const businessNumber = String(bindings[0] || '');
      const customerNumber = String(bindings[1] || '');
      return this.outboundMessages.has(`${businessNumber}->${customerNumber}`)
        ? { provider_message_id: this.outboundMessages.get(`${businessNumber}->${customerNumber}`) || null }
        : null;
    }

    return this.row;
  }

  resolveRun(sql: string, bindings: unknown[]): { meta?: { changes?: number } } {
    if (sql.includes('INSERT INTO leads')) {
      this.leads.push({
        phone: String(bindings[2] || ''),
        details: String(bindings[3] || ''),
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes('INSERT INTO calls')) {
      const providerCallId = String(bindings[2] || '');
      this.calls.set(providerCallId, {
        customer_welcome_sent_at: null,
        customer_welcome_message_id: null,
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes('SET customer_welcome_sent_at = datetime')) {
      const providerCallId = String(bindings[1] || '');
      const existing = this.calls.get(providerCallId);
      if (!existing || existing.customer_welcome_sent_at) {
        return { meta: { changes: 0 } };
      }

      existing.customer_welcome_sent_at = new Date().toISOString();
      this.calls.set(providerCallId, existing);
      return { meta: { changes: 1 } };
    }

    if (sql.includes('SET missed_at = CASE WHEN ? = 1') && sql.includes('customer_welcome_message_id')) {
      const messageSid = String(bindings[1] || '');
      const providerCallId = String(bindings[3] || '');
      const existing = this.calls.get(providerCallId) || {
        customer_welcome_sent_at: null,
        customer_welcome_message_id: null,
      };
      existing.customer_welcome_message_id = messageSid || null;
      this.calls.set(providerCallId, existing);
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 1 } };
  }
}

function assertNoEmoji(value: string) {
  assert.equal(/\p{Extended_Pictographic}/u.test(value), false, `Unexpected emoji in: ${value}`);
}

async function verifySmsFooterCompliance() {
  const firstBody = await prepareCustomerFacingSmsBody(
    new FakeDb(null) as unknown as D1Database,
    '+18443217137',
    '+12175550123',
    'First customer message'
  );
  assert.equal(firstBody, appendSmsOptOutFooter('First customer message'));
  assert.ok(firstBody.includes(SMS_OPT_OUT_FOOTER));

  const returningDb = new FakeDb(null);
  returningDb.outboundMessages.set('+18443217137->+12175550123', 'SMexisting');

  const secondBody = await prepareCustomerFacingSmsBody(
    returningDb as unknown as D1Database,
    '+18443217137',
    '+12175550123',
    'Follow-up customer message'
  );
  assert.equal(secondBody, 'Follow-up customer message');
  assert.equal(secondBody.includes(SMS_OPT_OUT_FOOTER), false);
}

async function verifyVoiceHookHelpers() {
  assert.equal(MISSED_CALL_VOICE_HOOK_MESSAGE, "Sorry we missed your call! What's going on? We can get a tech out faster if we have the details here.");
  assert.equal(shouldFireMissedCallVoiceHook('no-answer', MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER), true);
  assert.equal(shouldFireMissedCallVoiceHook('busy', MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER), true);
  assert.equal(shouldFireMissedCallVoiceHook('completed', MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER), false);
  assert.equal(shouldFireMissedCallVoiceHook('no-answer', '+15551234567'), false);
  assertNoEmoji(MISSED_CALL_VOICE_HOOK_MESSAGE);

  const voiceHookDb = new FakeDb({ business_number: MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER });
  const voiceHookBusiness = await findBusinessByNumber(voiceHookDb as unknown as D1Database, MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER);
  assert.deepEqual(voiceHookBusiness, {
    business_number: MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER,
    display_name: null,
  });
  assert.ok(voiceHookDb.lastStatement?.sql.includes('FROM businesses'));
  assert.ok(voiceHookDb.lastStatement?.sql.includes('WHERE business_number = ?'));
  assert.deepEqual(voiceHookDb.lastStatement?.lastBindings, [MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER]);
}

function verifyTwilioSmsSource() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const smsSourcePath = resolve(scriptDir, '../src/webhooks/twilioSms.ts');
  const smsSource = readFileSync(smsSourcePath, 'utf8');

  assert.ok(smsSource.includes('SELECT business_number, owner_phone_number, display_name'));
  assert.ok(smsSource.includes('WHERE business_number = ?'));
  assert.ok(smsSource.includes('const emergencySummary = await classifyLeadIntent(messageBody, apiKey);'));
  assert.ok(smsSource.includes('summary: emergencySummary.summary'));
  assert.ok(smsSource.includes('const emergencyCustomerMessage = buildEmergencyPriorityMessage(triage.summary, input.displayName);'));
  assert.ok(smsSource.includes('const ownerAlertBody = buildBusinessOwnerAlertMessage({'));
  assert.ok(smsSource.includes('const ownerAlertBody = buildOwnerAlertMessage('));
  assert.ok(smsSource.includes("source: 'post_classification_owner_alert'"));
  assert.equal(smsSource.includes('buildImmediateOwnerAlertMessage('), false);
  assert.ok(smsSource.includes("twilioLog.log('Emergency customer reply sent'"));
  assert.ok(smsSource.includes('displayName: businessContext.displayName'));

  assert.equal(
    buildEmergencyPriorityMessage('burst pipe in basement', 'Systemix Plumbing'),
    "🚨 Got it - we're on this. A local service provider has been notified and will call shortly. If not, reply here and we'll follow up."
  );
  assert.equal(
    buildEmergencyPriorityMessage('', ''),
    "🚨 Got it - we're on this. A local service provider has been notified and will call shortly. If not, reply here and we'll follow up."
  );
  assert.equal(
    buildOwnerAlertMessage('emergency', 'Burst pipe is flooding the basement.', '+12175550123'),
    'AI thinks this is an [Emergency]. Summary: Burst pipe is flooding the basement. Click here to call them back immediately: tel:+12175550123'
  );

  assert.equal(formatDisplayPhoneNumber('+12175550123'), '(217) 555-0123');
  assert.equal(formatDisplayPhoneNumber('2175550123'), '(217) 555-0123');
  assert.equal(formatDisplayPhoneNumber('(217) 555-0123'), '(217) 555-0123');

  assert.equal(
    buildBusinessOwnerAlertMessage({
      classification: 'emergency',
      summary: 'Burst pipe is flooding the basement.',
      customerNumber: '+12175550123',
      customerMessage: 'The basement is flooding from a burst pipe.',
    }),
    '🚨 EMERGENCY LEAD\n\nIssue: Burst pipe is flooding the basement\nCustomer: (217) 555-0123\n\nMessage:\n"The basement is flooding from a burst pipe."\n\nCall now: (217) 555-0123'
  );

  assert.equal(
    buildBusinessOwnerAlertMessage({
      classification: null,
      summary: null,
      customerNumber: '2175550123',
      customerMessage: 'Need a quote for a water heater next week.',
    }),
    '📩 NEW LEAD\n\nIssue: General Inquiry\nCustomer: (217) 555-0123\n\nMessage:\n"Need a quote for a water heater next week."\n\nReply or call: (217) 555-0123'
  );

  const longOwnerAlert = buildBusinessOwnerAlertMessage({
    classification: 'emergency',
    summary: 'Burst pipe is flooding the basement.',
    customerNumber: '+12175550123',
    customerMessage: 'A'.repeat(2000),
  });
  assert.ok(longOwnerAlert.includes('...'));
  assert.ok(longOwnerAlert.endsWith('Call now: (217) 555-0123'));
  assert.ok(longOwnerAlert.length <= 1500);
}

async function verifyOpenAiSchemaAndClassification() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const openAiSourcePath = resolve(scriptDir, '../src/services/openai.ts');
  const openAiSource = readFileSync(openAiSourcePath, 'utf8');

  assert.ok(openAiSource.includes('summary: z.string().trim().min(1)'));
  assert.ok(
    openAiSource.includes(
      "Return a one-sentence summary of the customer\\'s issue in plain language suitable for a business owner to read at a glance."
    )
  );

  const originalFetch = globalThis.fetch;
  const mockResponseBody = JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            classification: 'emergency',
            confidence: 'high',
            summary: 'Burst pipe is flooding the basement.',
          }),
        },
      },
    ],
  });

  let capturedRequestBody = '';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedRequestBody = String(init?.body || '');
    return new Response(mockResponseBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const classification = await classifyLeadIntent('The basement is flooding from a burst pipe.', 'test-key');
    assert.equal(classification.classification, 'emergency');
    assert.equal(classification.confidence, 'high');
    assert.equal(classification.summary, 'Burst pipe is flooding the basement.');
    const parsedRequestBody = JSON.parse(capturedRequestBody) as {
      response_format?: { type?: string };
      messages?: Array<{ content?: string }>;
    };
    assert.equal(parsedRequestBody.response_format?.type, 'json_object');
    assert.ok(parsedRequestBody.messages?.[0]?.content?.includes('"summary":string'));
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                classification: 'inquiry',
                confidence: 'low',
                summary: 'Customer wants a quote for a new water heater.',
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )) as typeof fetch;

  try {
    const lowConfidenceClassification = await classifyLeadIntent(
      'I might need a water heater quote next week.',
      'test-key'
    );
    assert.equal(lowConfidenceClassification.classification, 'emergency');
    assert.equal(lowConfidenceClassification.confidence, 'low');
    assert.equal(
      lowConfidenceClassification.summary,
      'Customer wants a quote for a new water heater.'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyVoiceHookSimulation() {
  const originalFetch = globalThis.fetch;
  const twilioBodies: string[] = [];
  const fakeDb = new FakeDb(null);
  fakeDb.businesses.set(MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER, {
    business_number: MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER,
    display_name: 'Systemix',
  });
  const scheduledTasks: Promise<unknown>[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || '');
    const params = new URLSearchParams(body);
    twilioBodies.push(params.get('Body') || '');
    return new Response(JSON.stringify({ sid: 'SMvoicehook' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const request = new Request('https://example.com/v1/webhooks/twilio/voice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: '+12175550123',
        To: MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER,
        CallStatus: 'no-answer',
        CallSid: 'CAvoicehook',
      }).toString(),
    });

    const response = await twilioVoiceHandler({
      env: {
        SYSTEMIX: fakeDb as unknown as D1Database,
        OPENAI_API_KEY: 'test',
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'auth',
        TWILIO_PHONE_NUMBER: MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER,
        TWILIO_SIGNATURE_MODE: 'off',
        ENVIRONMENT: 'development',
        WORKER_URL: 'https://example.com',
        SYSTEMIX_NUMBER: MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER,
      },
      req: {
        url: request.url,
        formData: () => request.formData(),
        header(name: string) {
          return request.headers.get(name) || undefined;
        },
      },
      executionCtx: {
        waitUntil(task: Promise<unknown>) {
          scheduledTasks.push(task);
        },
      },
      json(payload: unknown, status = 200) {
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      body(value: BodyInit | null, status = 200, headers?: HeadersInit) {
        return new Response(value, { status, headers });
      },
    } as never);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/xml');
    const body = await response.text();
    assert.ok(body.includes('<Response>'));
    assert.ok(body.includes('recordingStatusCallback="https://example.com/v1/webhooks/twilio/recording?from=%2B12175550123&amp;to=%2B18443217137"'));

    await Promise.all(scheduledTasks);

    assert.equal(fakeDb.leads.length, 1);
    assert.equal(fakeDb.leads[0]?.phone, '+12175550123');
    assert.equal(twilioBodies.length, 1);
    assert.equal(
      twilioBodies[0],
      appendSmsOptOutFooter(MISSED_CALL_VOICE_HOOK_MESSAGE)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function verifyTwilioValidationUrlConstruction() {
  assert.equal(
    buildTwilioValidationUrl(
      { WORKER_URL: 'http://systemix-backend.sean-ndele.workers.dev/internal' },
      'http://workers.internal/v1/webhooks/twilio/voice?CallSid=CA123'
    ),
    'https://systemix-backend.sean-ndele.workers.dev/v1/webhooks/twilio/voice?CallSid=CA123'
  );
}

async function main() {
  await verifyVoiceHookHelpers();
  await verifySmsFooterCompliance();
  verifyTwilioSmsSource();
  await verifyOpenAiSchemaAndClassification();
  verifyTwilioValidationUrlConstruction();
  await verifyVoiceHookSimulation();
  verifyLog.log('Local verification passed');
}

main().catch((error) => {
  verifyLog.error('Local verification failed', {
    error,
  });
  process.exit(1);
});

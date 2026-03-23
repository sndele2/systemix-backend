import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLeadIntent } from '../src/services/openai.ts';
import {
  buildEmergencyPriorityMessage,
  findBusinessByNumber,
  MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER,
  MISSED_CALL_VOICE_HOOK_MESSAGE,
  shouldFireMissedCallVoiceHook,
} from '../src/services/twilioLaunch.ts';

type FakeRow = Record<string, unknown> | null;

class FakeStatement {
  sql: string;
  row: FakeRow;
  lastBindings: unknown[] = [];

  constructor(sql: string, row: FakeRow) {
    this.sql = sql;
    this.row = row;
  }

  bind(...values: unknown[]) {
    this.lastBindings = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.row as T | null) ?? null;
  }
}

class FakeDb {
  lastStatement: FakeStatement | null = null;
  row: FakeRow;

  constructor(row: FakeRow) {
    this.row = row;
  }

  prepare(sql: string) {
    this.lastStatement = new FakeStatement(sql, this.row);
    return this.lastStatement;
  }
}

function assertNoEmoji(value: string) {
  assert.equal(/\p{Extended_Pictographic}/u.test(value), false, `Unexpected emoji in: ${value}`);
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
  assert.deepEqual(voiceHookBusiness, { business_number: MISSED_CALL_VOICE_HOOK_BUSINESS_NUMBER });
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
  assert.ok(smsSource.includes("console.log('[TWILIO] EMERGENCY SMS SENT'"));
  assert.ok(smsSource.includes('displayName: businessContext.displayName'));

  assert.equal(
    buildEmergencyPriorityMessage('burst pipe in basement', 'Systemix Plumbing'),
    "Emergency Priority: I've escalated your 'burst pipe in basement' to the Systemix Plumbing team. Expect a call in the next few minutes."
  );
  assert.equal(
    buildEmergencyPriorityMessage('', ''),
    "Emergency Priority: I've escalated your 'your request' to the team. Expect a call in the next few minutes."
  );
  assertNoEmoji(buildEmergencyPriorityMessage('burst pipe in basement', 'Systemix Plumbing'));
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
}

async function main() {
  await verifyVoiceHookHelpers();
  verifyTwilioSmsSource();
  await verifyOpenAiSchemaAndClassification();
  console.log('V1 final polish local verification passed.');
}

main().catch((error) => {
  console.error('V1 final polish local verification failed.');
  console.error(error);
  process.exit(1);
});

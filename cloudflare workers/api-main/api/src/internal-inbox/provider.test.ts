// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInternalInboxConversationId,
  D1InternalInboxProvider,
} from './index.ts';

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

class MockPreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.boundArgs = [];
  }

  bind(...args) {
    this.boundArgs = args;
    return this;
  }

  async all() {
    return this.db.handleAll(this.sql, this.boundArgs);
  }

  async first() {
    return this.db.handleFirst(this.sql, this.boundArgs);
  }

  async run() {
    return this.db.handleRun(this.sql, this.boundArgs);
  }
}

class MockDatabase {
  constructor(data) {
    this.data = data;
    this.insertedMessages = [];
    this.upsertedSessions = [];
  }

  prepare(sql) {
    return new MockPreparedStatement(this, sql);
  }

  async handleAll(sql, args) {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('with conversation_pairs as')) {
      return {
        results: this.data.conversationPairs,
      };
    }

    if (normalized.includes('from missed_call_conversations')) {
      const [businessNumber, customerNumber] = args;
      return {
        results: (this.data.missedCalls || []).filter(
          (row) => row.business_number === businessNumber && row.phone_number === customerNumber
        ),
      };
    }

    if (normalized.includes('from calls')) {
      const [customerNumber, businessNumber] = args;
      return {
        results: (this.data.calls || []).filter(
          (row) => row.from_phone === customerNumber && row.to_phone === businessNumber
        ),
      };
    }

    if (normalized.includes('from messages')) {
      const [customerNumber, businessNumber] = args;
      return {
        results: (this.data.messages || []).filter(
          (row) =>
            (row.from_phone === customerNumber && row.to_phone === businessNumber) ||
            (row.from_phone === businessNumber && row.to_phone === customerNumber)
        ),
      };
    }

    throw new Error(`Unhandled all() SQL: ${normalized}`);
  }

  async handleFirst(sql, args) {
    const normalized = normalizeSql(sql);

    if (normalized.includes('select status, last_activity_at from active_sessions')) {
      const [businessNumber, customerNumber] = args;
      return (
        (this.data.activeSessions || []).find(
          (row) => row.business_number === businessNumber && row.customer_number === customerNumber
        ) || null
      );
    }

    if (normalized.startsWith('select 1 as found from (')) {
      const [, businessNumber, customerNumber] = args;
      const found = (this.data.conversationPairs || []).some(
        (row) => row.business_number === businessNumber && row.customer_number === customerNumber
      );
      return found ? { found: 1 } : null;
    }

    throw new Error(`Unhandled first() SQL: ${normalized}`);
  }

  async handleRun(sql, args) {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('insert into messages')) {
      this.insertedMessages.push(args);
      return {
        meta: {
          changes: 1,
        },
      };
    }

    if (normalized.startsWith('insert into active_sessions')) {
      this.upsertedSessions.push(args);
      return {
        meta: {
          changes: 1,
        },
      };
    }

    throw new Error(`Unhandled run() SQL: ${normalized}`);
  }
}

function createProviderHarness() {
  const businessNumber = '+18443217137';
  const customerNumber = '+12175550123';
  const conversationId = createInternalInboxConversationId(businessNumber, customerNumber);

  const db = new MockDatabase({
    conversationPairs: [
      {
        business_number: businessNumber,
        customer_number: customerNumber,
      },
    ],
    missedCalls: [
      {
        id: 'missed-call-1',
        business_number: businessNumber,
        phone_number: customerNumber,
        missed_call_timestamp: '2026-04-16T12:00:00.000Z',
        sms_sent: 1,
        sms_content: 'Sorry we missed your call. What is going on?',
        reply_received: 1,
        reply_text: 'Please call me back.',
        reply_timestamp: '2026-04-16T12:05:00.000Z',
      },
    ],
    calls: [
      {
        id: 'call-1',
        provider_call_id: 'CA123',
        from_phone: customerNumber,
        to_phone: businessNumber,
        created_at: '2026-04-16T12:00:30.000Z',
        missed_at: '2026-04-16T12:00:00.000Z',
        transcription: 'Water heater is leaking.',
        recording_url: 'https://example.com/recording.wav',
        customer_welcome_sent_at: '2026-04-16T12:01:00.000Z',
        customer_welcome_message_id: 'SMWELCOME1',
      },
    ],
    messages: [
      {
        id: 'message-1',
        created_at: '2026-04-16T12:05:00.000Z',
        direction: 'inbound',
        provider_message_id: 'SMINBOUND1',
        from_phone: customerNumber,
        to_phone: businessNumber,
        body: 'Please call me back.',
        raw_json: JSON.stringify({
          source: 'twilio_sms_webhook',
          timestamp: '2026-04-16T12:05:00.000Z',
        }),
      },
      {
        id: 'message-2',
        created_at: '2026-04-16T12:10:00.000Z',
        direction: 'outbound',
        provider_message_id: 'SMOUTBOUND1',
        from_phone: businessNumber,
        to_phone: customerNumber,
        body: 'We are on our way.',
        raw_json: JSON.stringify({
          source: 'owner_relay_forward',
          timestamp: '2026-04-16T12:10:00.000Z',
        }),
      },
    ],
    activeSessions: [
      {
        business_number: businessNumber,
        customer_number: customerNumber,
        status: 'active',
        last_activity_at: '2026-04-16T12:10:00.000Z',
      },
    ],
  });

  const twilioCalls = [];
  const twilioClient = {
    async sendSms(input) {
      twilioCalls.push(input);
      return {
        ok: true,
        sid: 'SMOPERATOR1',
      };
    },
  };

  return {
    db,
    twilioCalls,
    conversationId,
    provider: new D1InternalInboxProvider(
      {
        SYSTEMIX: db,
        TWILIO_ACCOUNT_SID: 'sid',
        TWILIO_AUTH_TOKEN: 'token',
      },
      twilioClient
    ),
  };
}

test('lists and loads SMS/missed-call conversations from D1 instead of email data', async () => {
  const { provider, conversationId } = createProviderHarness();

  const listResult = await provider.listConversations('+18443217137', 10);
  assert.equal(listResult.ok, true);
  assert.deepEqual(listResult.value, [
    {
      id: conversationId,
      businessNumber: '+18443217137',
      contact: {
        phoneNumber: '+12175550123',
      },
      source: 'sms',
      preview: 'We are on our way.',
      updatedAt: '2026-04-16T12:10:00.000Z',
    },
  ]);

  const conversationResult = await provider.getConversation('+18443217137', conversationId);
  assert.equal(conversationResult.ok, true);
  assert.deepEqual(conversationResult.value, {
    id: conversationId,
    businessNumber: '+18443217137',
    contact: {
      phoneNumber: '+12175550123',
    },
    source: 'sms',
    updatedAt: '2026-04-16T12:10:00.000Z',
    messages: [
      {
        id: 'missed-call:missed-call-1',
        type: 'system',
        source: 'missed_call',
        body: 'Missed call detected from +12175550123.',
        timestamp: '2026-04-16T12:00:00.000Z',
        rawProviderId: 'missed-call-1',
      },
      {
        id: 'voicemail:call-1',
        type: 'system',
        source: 'voicemail',
        body: 'Water heater is leaking.',
        timestamp: '2026-04-16T12:00:30.000Z',
        rawProviderId: 'CA123',
      },
      {
        id: 'auto-text:missed-call-1',
        type: 'system',
        source: 'sms',
        body: 'Sorry we missed your call. What is going on?',
        timestamp: '2026-04-16T12:01:00.000Z',
        rawProviderId: null,
      },
      {
        id: 'message:message-1',
        type: 'customer',
        source: 'sms',
        body: 'Please call me back.',
        timestamp: '2026-04-16T12:05:00.000Z',
        rawProviderId: 'SMINBOUND1',
      },
      {
        id: 'message:message-2',
        type: 'operator',
        source: 'sms',
        body: 'We are on our way.',
        timestamp: '2026-04-16T12:10:00.000Z',
        rawProviderId: 'SMOUTBOUND1',
      },
    ],
  });
});

test('replyToConversation resolves the customer target from the conversation id', async () => {
  const { provider, db, twilioCalls, conversationId } = createProviderHarness();

  const replyResult = await provider.replyToConversation(
    '+18443217137',
    conversationId,
    'Thanks, we are on it.'
  );

  assert.deepEqual(replyResult, {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(twilioCalls, [
    {
      toPhone: '+12175550123',
      fromPhone: '+18443217137',
      businessNumber: '+18443217137',
      body: 'Thanks, we are on it.',
    },
  ]);

  assert.equal(db.insertedMessages.length, 1);
  assert.equal(db.insertedMessages[0][2], 'SMOPERATOR1');
  assert.equal(db.insertedMessages[0][3], '+18443217137');
  assert.equal(db.insertedMessages[0][4], '+12175550123');
  assert.equal(db.insertedMessages[0][5], 'Thanks, we are on it.');

  const replyMetadata = JSON.parse(db.insertedMessages[0][6]);
  assert.equal(replyMetadata.source, 'internal_inbox_operator_reply');
  assert.equal(replyMetadata.conversationId, conversationId);
  assert.equal(replyMetadata.business_number, '+18443217137');
  assert.equal(replyMetadata.customer_number, '+12175550123');

  assert.equal(db.upsertedSessions.length, 1);
  assert.equal(db.upsertedSessions[0][1], '+18443217137');
  assert.equal(db.upsertedSessions[0][2], '+12175550123');
  assert.equal(db.upsertedSessions[0][3], conversationId);
});

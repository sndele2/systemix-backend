// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { EmailClient } from './email-client.ts';
import { ReplyClassifier } from './reply-classifier.ts';
import { SequenceEngine } from './sequence-engine.ts';
import { GTMService } from './service.ts';

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = () => {};
console.error = () => {};

test.after(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

class FakeLeadStore {
  constructor(eventLog = []) {
    this.eventLog = eventLog;
    this.leads = new Map();
    this.replies = new Map();
    this.syncCursor = null;
    this.touchpoints = [];
    this.readyLeads = [];
    this.calls = [];
    this.failures = {
      createLead: null,
      createReply: null,
      findLeadByEmail: null,
      getSyncCursor: null,
      updateLead: null,
      updateReply: null,
      getLeadById: null,
      listReplies: null,
      listRepliesByLeadId: null,
      listTouchpointsByLeadId: null,
      listLeadsReadyForNextAction: null,
      recordTouchpoint: null,
      markStopped: null,
      setSyncCursor: null,
    };
    this.lastReadySequence = null;
  }

  seedLead(lead) {
    this.leads.set(lead.id, { ...lead });
  }

  async createLead(lead) {
    this.eventLog.push('createLead');
    this.calls.push({ method: 'createLead', leadId: lead.id });

    if (this.failures.createLead) {
      return { ok: false, error: this.failures.createLead };
    }

    if (this.leads.has(lead.id)) {
      return { ok: false, error: 'Lead already exists' };
    }

    this.leads.set(lead.id, {
      ...lead,
      status: 'pending',
      touches_sent: 0,
    });

    return { ok: true, value: undefined };
  }

  async createReply(reply) {
    this.eventLog.push('createReply');
    this.calls.push({ method: 'createReply', replyId: reply.id });

    if (this.failures.createReply) {
      return { ok: false, error: this.failures.createReply };
    }

    if (this.replies.has(reply.id)) {
      return { ok: true, value: 'exists' };
    }

    this.replies.set(reply.id, { ...reply });
    return { ok: true, value: 'created' };
  }

  async findLeadByEmail(email) {
    this.eventLog.push('findLeadByEmail');
    this.calls.push({ method: 'findLeadByEmail', email });

    if (this.failures.findLeadByEmail) {
      return { ok: false, error: this.failures.findLeadByEmail };
    }

    const normalizedEmail = email.trim().toLowerCase();
    const lead =
      Array.from(this.leads.values()).find(
        (candidate) => candidate.email.trim().toLowerCase() === normalizedEmail
      ) ?? null;

    return { ok: true, value: lead };
  }

  async getSyncCursor() {
    this.eventLog.push('getSyncCursor');
    this.calls.push({ method: 'getSyncCursor' });

    if (this.failures.getSyncCursor) {
      return { ok: false, error: this.failures.getSyncCursor };
    }

    return { ok: true, value: this.syncCursor };
  }

  async updateLead(leadId, patch) {
    this.eventLog.push('updateLead');
    this.calls.push({ method: 'updateLead', leadId, patch });

    if (this.failures.updateLead) {
      return { ok: false, error: this.failures.updateLead };
    }

    const lead = this.leads.get(leadId);
    if (!lead) {
      return { ok: false, error: 'Lead not found' };
    }

    this.leads.set(leadId, {
      ...lead,
      ...patch,
    });

    return { ok: true, value: undefined };
  }

  async updateReply(replyId, patch) {
    this.eventLog.push('updateReply');
    this.calls.push({ method: 'updateReply', replyId, patch });

    if (this.failures.updateReply) {
      return { ok: false, error: this.failures.updateReply };
    }

    const reply = this.replies.get(replyId);
    if (!reply) {
      return { ok: false, error: 'Reply not found' };
    }

    this.replies.set(replyId, {
      ...reply,
      ...patch,
    });

    return { ok: true, value: undefined };
  }

  async getLeadById(leadId) {
    this.eventLog.push('getLeadById');
    this.calls.push({ method: 'getLeadById', leadId });

    if (this.failures.getLeadById) {
      return { ok: false, error: this.failures.getLeadById };
    }

    return { ok: true, value: this.leads.get(leadId) ?? null };
  }

  async listReplies(limit, matchedOnly) {
    this.eventLog.push('listReplies');
    this.calls.push({ method: 'listReplies', limit, matchedOnly });

    if (this.failures.listReplies) {
      return { ok: false, error: this.failures.listReplies };
    }

    const replies = Array.from(this.replies.values())
      .filter((reply) => !matchedOnly || reply.lead_id !== null)
      .sort((left, right) => right.received_at.localeCompare(left.received_at))
      .slice(0, limit);

    return { ok: true, value: replies };
  }

  async listRepliesByLeadId(leadId) {
    this.eventLog.push('listRepliesByLeadId');
    this.calls.push({ method: 'listRepliesByLeadId', leadId });

    if (this.failures.listRepliesByLeadId) {
      return { ok: false, error: this.failures.listRepliesByLeadId };
    }

    const replies = Array.from(this.replies.values())
      .filter((reply) => reply.lead_id === leadId)
      .sort((left, right) => right.received_at.localeCompare(left.received_at));

    return { ok: true, value: replies };
  }

  async listTouchpointsByLeadId(leadId) {
    this.eventLog.push('listTouchpointsByLeadId');
    this.calls.push({ method: 'listTouchpointsByLeadId', leadId });

    if (this.failures.listTouchpointsByLeadId) {
      return { ok: false, error: this.failures.listTouchpointsByLeadId };
    }

    return {
      ok: true,
      value: this.touchpoints
        .filter((touchpoint) => touchpoint.lead_id === leadId)
        .sort((left, right) => left.sent_at.localeCompare(right.sent_at)),
    };
  }

  async listLeadsReadyForNextAction(sequence) {
    this.eventLog.push('listLeadsReadyForNextAction');
    this.calls.push({ method: 'listLeadsReadyForNextAction' });
    this.lastReadySequence = sequence;

    if (this.failures.listLeadsReadyForNextAction) {
      return { ok: false, error: this.failures.listLeadsReadyForNextAction };
    }

    return { ok: true, value: this.readyLeads };
  }

  async recordTouchpoint(touchpoint) {
    this.eventLog.push('recordTouchpoint');
    this.calls.push({ method: 'recordTouchpoint', touchpoint });

    if (this.failures.recordTouchpoint) {
      return { ok: false, error: this.failures.recordTouchpoint };
    }

    this.touchpoints.push(touchpoint);
    return { ok: true, value: undefined };
  }

  async markStopped(leadId, reason, stoppedAt) {
    this.eventLog.push('markStopped');
    this.calls.push({ method: 'markStopped', leadId, reason, stoppedAt });

    if (this.failures.markStopped) {
      return { ok: false, error: this.failures.markStopped };
    }

    const lead = this.leads.get(leadId);
    if (!lead) {
      return { ok: false, error: 'Lead not found' };
    }

    this.leads.set(leadId, {
      ...lead,
      status: reason,
      stopped_at: stoppedAt,
    });

    return { ok: true, value: undefined };
  }

  async setSyncCursor(lastSyncedAt, updatedAt) {
    this.eventLog.push('setSyncCursor');
    this.calls.push({ method: 'setSyncCursor', lastSyncedAt, updatedAt });

    if (this.failures.setSyncCursor) {
      return { ok: false, error: this.failures.setSyncCursor };
    }

    this.syncCursor = {
      id: 'gtm-reply-cursor',
      last_synced_at: lastSyncedAt,
      updated_at: updatedAt,
    };

    return { ok: true, value: undefined };
  }
}

class TestEmailClient extends EmailClient {
  constructor(eventLog = []) {
    super({
      fromEmail: 'gtm@example.com',
      fromName: 'Systemix',
      maxTouches: 3,
      dryRun: true,
    });
    this.eventLog = eventLog;
    this.calls = [];
    this.nextResult = {
      success: true,
      dryRun: true,
      messageId: null,
    };
    this.throwError = null;
  }

  async send(message) {
    this.eventLog.push('emailSend');
    this.calls.push(message);

    if (this.throwError) {
      throw this.throwError;
    }

    return this.nextResult;
  }
}

class ThrowingReplyClassifier extends ReplyClassifier {
  classify() {
    throw new Error('classifier unavailable');
  }
}

class FakeInboxProvider {
  constructor() {
    this.calls = [];
    this.messages = [];
    this.failure = null;
  }

  async listMessages(cursor) {
    this.calls.push(cursor);

    if (this.failure) {
      return { ok: false, error: this.failure };
    }

    return { ok: true, value: this.messages };
  }
}

function buildLead(overrides = {}) {
  return {
    id: 'lead-123',
    name: 'Jordan',
    email: 'jordan@example.com',
    phone: '+13125550199',
    createdAt: '2026-04-14T00:00:00.000Z',
    metadata: { source: 'missed-call' },
    status: 'pending',
    touches_sent: 0,
    ...overrides,
  };
}

function createService(options = {}) {
  const eventLog = options.eventLog ?? [];
  const store = options.store ?? new FakeLeadStore(eventLog);
  const emailClient = options.emailClient ?? new TestEmailClient(eventLog);
  const replyClassifier = options.replyClassifier ?? new ReplyClassifier();
  const inboxProvider = options.inboxProvider ?? new FakeInboxProvider();
  const config = {
    fromEmail: 'gtm@example.com',
    fromName: 'Systemix',
    maxTouches: 3,
    dryRun: true,
    ...options.config,
  };
  const sequenceEngine = options.sequenceEngine ?? new SequenceEngine({ maxTouches: config.maxTouches });

  return {
    eventLog,
    store,
    emailClient,
    inboxProvider,
    service: new GTMService({
      store,
      emailClient,
      sequenceEngine,
      replyClassifier,
      config,
      inboxProvider,
    }),
  };
}

test('createLead persists a new lead and rejects restarting an active one', async () => {
  const lead = buildLead();
  const { service, store } = createService();

  assert.deepEqual(await service.createLead(lead), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(await service.createLead({ ...lead, name: 'Updated Jordan' }), {
    ok: false,
    error: 'Lead already exists',
  });

  store.seedLead(buildLead({ id: 'lead-999', status: 'active' }));

  assert.deepEqual(
    await service.createLead({
      id: 'lead-999',
      name: 'Taylor',
      email: 'taylor@example.com',
      createdAt: '2026-04-14T01:00:00.000Z',
    }),
    {
      ok: false,
      error: 'Lead already exists with status active',
    }
  );
});

test('startSequence moves a pending lead to active without sending', async () => {
  const { service, store, emailClient } = createService();
  store.seedLead(buildLead());

  assert.deepEqual(await service.startSequence('lead-123'), {
    ok: true,
    value: undefined,
  });
  assert.equal(store.leads.get('lead-123').status, 'active');
  assert.equal(emailClient.calls.length, 0);
});

test('prepareNextAction is read-only and returns the rendered send action', async () => {
  const { service, store } = createService();
  store.seedLead(buildLead({ status: 'active' }));

  const result = await service.prepareNextAction('lead-123');
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.action, 'send');
  assert.equal(result.value.stage.stageIndex, 0);
  assert.match(result.value.subject, /Jordan/);
  assert.deepEqual(
    store.calls.map((entry) => entry.method),
    ['getLeadById', 'listTouchpointsByLeadId']
  );
});

test('advanceLeadSequence persists the touchpoint before the email call and then updates the lead', async () => {
  const { service, store, emailClient, eventLog } = createService();
  store.seedLead(buildLead({ status: 'active' }));

  const result = await service.advanceLeadSequence('lead-123');
  assert.deepEqual(result, {
    ok: true,
    value: {
      action: 'skipped',
      leadId: 'lead-123',
      reason: 'dry_run',
    },
  });

  assert.deepEqual(eventLog, [
    'getLeadById',
    'listTouchpointsByLeadId',
    'getLeadById',
    'recordTouchpoint',
    'emailSend',
    'updateLead',
  ]);
  assert.equal(emailClient.calls.length, 1);
  assert.equal(store.touchpoints.length, 1);
  assert.equal(store.touchpoints[0].dry_run, true);
  assert.equal(store.touchpoints[0].result, 'skipped');
  assert.equal(store.leads.get('lead-123').touches_sent, 1);
  assert.equal(store.leads.get('lead-123').last_stage_index, 0);
  assert.equal(typeof store.leads.get('lead-123').last_sent_at, 'string');
});

test('advanceLeadSequence returns an error and never sends when touchpoint persistence fails', async () => {
  const { service, store, emailClient } = createService();
  store.seedLead(buildLead({ status: 'active' }));
  store.failures.recordTouchpoint = 'touchpoint persistence failed';

  assert.deepEqual(await service.advanceLeadSequence('lead-123'), {
    ok: false,
    error: 'touchpoint persistence failed',
  });
  assert.equal(emailClient.calls.length, 0);
});

test('advanceLeadSequence rejects live mode until the email client is wired for production sending', async () => {
  const { service, store, emailClient } = createService({
    config: { dryRun: false },
  });
  store.seedLead(buildLead({ status: 'active' }));

  assert.deepEqual(await service.advanceLeadSequence('lead-123'), {
    ok: false,
    error: 'Live GTM email sending is not implemented',
  });
  assert.equal(store.touchpoints.length, 0);
  assert.equal(emailClient.calls.length, 0);
});

test('advanceLeadSequence marks exhausted leads as stopped', async () => {
  const { service, store, emailClient } = createService();
  store.seedLead(buildLead({ status: 'active', touches_sent: 3, last_stage_index: 2 }));

  const result = await service.advanceLeadSequence('lead-123');
  assert.deepEqual(result, {
    ok: true,
    value: {
      action: 'stopped',
      leadId: 'lead-123',
      reason: 'exhausted',
    },
  });

  assert.equal(store.leads.get('lead-123').status, 'exhausted');
  assert.equal(emailClient.calls.length, 0);
});

test('advanceLeadSequence does not retry the email send when the final state update fails', async () => {
  const { service, store, emailClient } = createService();
  store.seedLead(buildLead({ status: 'active' }));
  store.failures.updateLead = 'failed to update lead state';

  assert.deepEqual(await service.advanceLeadSequence('lead-123'), {
    ok: false,
    error: 'failed to update lead state',
  });
  assert.equal(emailClient.calls.length, 1);
});

test('recordReply always stops the lead even if classification fails', async () => {
  const store = new FakeLeadStore();
  store.seedLead(buildLead({ status: 'active' }));
  const emailClient = new TestEmailClient();
  const service = new GTMService({
    store,
    emailClient,
    sequenceEngine: new SequenceEngine({ maxTouches: 3 }),
    replyClassifier: new ThrowingReplyClassifier(),
    config: {
      fromEmail: 'gtm@example.com',
      fromName: 'Systemix',
      maxTouches: 3,
      dryRun: true,
    },
  });

  assert.deepEqual(await service.recordReply('lead-123', 'Please stop emailing me'), {
    ok: true,
    value: {
      classification: 'unknown',
    },
  });
  assert.equal(store.leads.get('lead-123').status, 'replied');
});

test('syncAndListReplies stores matched and unmatched inbox replies and updates the cursor', async () => {
  const { service, store, inboxProvider } = createService();
  store.seedLead(buildLead({ status: 'active' }));
  inboxProvider.messages = [
    {
      id: 'reply-1',
      fromEmail: 'Jordan@Example.com',
      subject: 'Re: missed call',
      bodySnippet: 'Thanks, call me back tomorrow.',
      receivedAt: '2026-04-16T12:00:00.000Z',
      conversationId: 'conversation-1',
      rawProviderId: 'reply-1',
    },
    {
      id: 'reply-2',
      fromEmail: 'new-lead@example.com',
      subject: 'Question',
      bodySnippet: 'Can you quote this job?',
      receivedAt: '2026-04-16T12:05:00.000Z',
      conversationId: 'conversation-2',
      rawProviderId: 'reply-2',
    },
  ];

  const result = await service.syncAndListReplies(50, false);
  assert.equal(result.ok, true);
  assert.equal(result.value.synced_at, '2026-04-16T12:05:00.000Z');
  assert.equal(result.value.new_replies_found, 2);
  assert.equal(result.value.replies.length, 2);
  assert.equal(store.leads.get('lead-123').status, 'replied');
  assert.equal(inboxProvider.calls[0], '1970-01-01T00:00:00.000Z');
  assert.equal(store.syncCursor.last_synced_at, '2026-04-16T12:05:00.000Z');
  assert.deepEqual(store.replies.get('reply-1'), {
    id: 'reply-1',
    lead_id: 'lead-123',
    from_email: 'Jordan@Example.com',
    subject: 'Re: missed call',
    body_snippet: 'Thanks, call me back tomorrow.',
    received_at: '2026-04-16T12:00:00.000Z',
    conversation_id: 'conversation-1',
    classification: 'reply_detected',
    sequence_stopped: true,
    raw_provider_id: 'reply-1',
    created_at: store.replies.get('reply-1').created_at,
  });
  assert.deepEqual(store.replies.get('reply-2'), {
    id: 'reply-2',
    lead_id: null,
    from_email: 'new-lead@example.com',
    subject: 'Question',
    body_snippet: 'Can you quote this job?',
    received_at: '2026-04-16T12:05:00.000Z',
    conversation_id: 'conversation-2',
    classification: 'unknown',
    sequence_stopped: false,
    raw_provider_id: 'reply-2',
    created_at: store.replies.get('reply-2').created_at,
  });
});

test('syncAndListReplies continues after a reply-processing failure and overlaps the cursor for retry', async () => {
  const { service, store, inboxProvider } = createService();
  store.seedLead(buildLead({ status: 'active' }));
  store.failures.markStopped = 'failed to stop lead';
  inboxProvider.messages = [
    {
      id: 'reply-1',
      fromEmail: 'jordan@example.com',
      subject: 'Re: missed call',
      bodySnippet: 'Please stop.',
      receivedAt: '2026-04-16T12:00:00.000Z',
      conversationId: 'conversation-1',
      rawProviderId: 'reply-1',
    },
    {
      id: 'reply-2',
      fromEmail: 'new-lead@example.com',
      subject: 'Question',
      bodySnippet: 'Need help.',
      receivedAt: '2026-04-16T12:05:00.000Z',
      conversationId: 'conversation-2',
      rawProviderId: 'reply-2',
    },
  ];

  const result = await service.syncAndListReplies(50, false);
  assert.equal(result.ok, true);
  assert.equal(result.value.synced_at, '2026-04-16T11:59:59.999Z');
  assert.equal(result.value.new_replies_found, 2);
  assert.equal(store.leads.get('lead-123').status, 'active');
  assert.equal(store.replies.get('reply-1').lead_id, 'lead-123');
  assert.equal(store.replies.get('reply-1').sequence_stopped, false);
  assert.equal(store.replies.get('reply-2').lead_id, null);
  assert.equal(store.syncCursor.last_synced_at, '2026-04-16T11:59:59.999Z');
});

test('getLeadsReadyForNextAction delegates the engine sequence to the store', async () => {
  const { service, store } = createService({
    config: { maxTouches: 2 },
  });
  store.readyLeads = [buildLead({ status: 'active', id: 'lead-ready' })];

  const result = await service.getLeadsReadyForNextAction();
  assert.deepEqual(result, {
    ok: true,
    value: store.readyLeads,
  });
  assert.equal(store.lastReadySequence.length, 2);
});

// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { DurableLeadStore } from './lead-store.ts';
import { DEFAULT_SEQUENCE } from './sequence-engine.ts';

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.boundValues = [];
  }

  bind(...values) {
    this.boundValues = values;
    return this;
  }

  async run() {
    return this.db.run(this.sql, this.boundValues);
  }

  async first() {
    return this.db.first(this.sql, this.boundValues);
  }

  async all() {
    return this.db.all(this.sql, this.boundValues);
  }
}

class FakeD1Database {
  constructor() {
    this.leads = new Map();
    this.replies = new Map();
    this.syncCursor = null;
    this.touchpoints = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  getLead(id) {
    return this.leads.get(id) ?? null;
  }

  getTouchpoint(id) {
    return this.touchpoints.get(id) ?? null;
  }

  getReply(id) {
    return this.replies.get(id) ?? null;
  }

  normalizeSql(sql) {
    return sql.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  cloneLeadRow(lead) {
    return {
      id: lead.id,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      status: lead.status,
      touches_sent: lead.touches_sent,
      last_stage_index: lead.last_stage_index,
      last_sent_at: lead.last_sent_at,
      stopped_at: lead.stopped_at,
      created_at: lead.created_at,
      metadata: lead.metadata,
    };
  }

  cloneReplyRow(reply) {
    return {
      id: reply.id,
      lead_id: reply.lead_id,
      from_email: reply.from_email,
      subject: reply.subject,
      body_snippet: reply.body_snippet,
      received_at: reply.received_at,
      conversation_id: reply.conversation_id,
      classification: reply.classification,
      sequence_stopped: reply.sequence_stopped,
      raw_provider_id: reply.raw_provider_id,
      created_at: reply.created_at,
    };
  }

  latestTouchpointSentAt(leadId) {
    const matchingTouchpoints = Array.from(this.touchpoints.values())
      .filter((touchpoint) => touchpoint.lead_id === leadId)
      .sort((left, right) => right.sent_at.localeCompare(left.sent_at));

    return matchingTouchpoints[0]?.sent_at ?? null;
  }

  async run(sql, boundValues) {
    const normalizedSql = this.normalizeSql(sql);

    if (normalizedSql.startsWith('insert into gtm_leads')) {
      const [id, name, email, phone, status, touchesSent, lastStageIndex, lastSentAt, stoppedAt, createdAt, metadata] =
        boundValues;

      if (this.leads.has(String(id))) {
        throw new Error('UNIQUE constraint failed: gtm_leads.id');
      }

      this.leads.set(String(id), {
        id: String(id),
        name: String(name),
        email: String(email),
        phone: phone === null ? null : String(phone),
        status: String(status),
        touches_sent: Number(touchesSent),
        last_stage_index: lastStageIndex === null ? null : Number(lastStageIndex),
        last_sent_at: lastSentAt === null ? null : String(lastSentAt),
        stopped_at: stoppedAt === null ? null : String(stoppedAt),
        created_at: String(createdAt),
        metadata: metadata === null ? null : String(metadata),
      });

      return { meta: { changes: 1 } };
    }

    if (normalizedSql.startsWith('update gtm_leads set ')) {
      const leadId = String(boundValues[boundValues.length - 1]);
      const lead = this.leads.get(leadId);
      if (!lead) {
        return { meta: { changes: 0 } };
      }

      const assignmentsFragment = normalizedSql
        .replace('update gtm_leads set ', '')
        .replace(' where id = ?', '');
      const assignments = assignmentsFragment.split(',').map((assignment) => assignment.trim());

      for (const [index, assignment] of assignments.entries()) {
        const column = assignment.replace(' = ?', '');
        lead[column] = boundValues[index] ?? null;
      }

      return { meta: { changes: 1 } };
    }

    if (normalizedSql.startsWith('insert into gtm_touchpoints')) {
      const [id, leadId, stageIndex, sentAt, dryRun, result, messageId] = boundValues;

      if (this.touchpoints.has(String(id))) {
        throw new Error('UNIQUE constraint failed: gtm_touchpoints.id');
      }

      if (!this.leads.has(String(leadId))) {
        throw new Error('FOREIGN KEY constraint failed');
      }

      this.touchpoints.set(String(id), {
        id: String(id),
        lead_id: String(leadId),
        stage_index: Number(stageIndex),
        sent_at: String(sentAt),
        dry_run: Number(dryRun),
        result: String(result),
        message_id: messageId === null ? null : String(messageId),
      });

      return { meta: { changes: 1 } };
    }

    if (normalizedSql.startsWith('insert or ignore into gtm_replies')) {
      const [
        id,
        leadId,
        fromEmail,
        subject,
        bodySnippet,
        receivedAt,
        conversationId,
        classification,
        sequenceStopped,
        rawProviderId,
        createdAt,
      ] = boundValues;

      if (this.replies.has(String(id))) {
        return { meta: { changes: 0 } };
      }

      this.replies.set(String(id), {
        id: String(id),
        lead_id: leadId === null ? null : String(leadId),
        from_email: String(fromEmail),
        subject: subject === null ? null : String(subject),
        body_snippet: String(bodySnippet),
        received_at: String(receivedAt),
        conversation_id: conversationId === null ? null : String(conversationId),
        classification: String(classification),
        sequence_stopped: Number(sequenceStopped),
        raw_provider_id: rawProviderId === null ? null : String(rawProviderId),
        created_at: String(createdAt),
      });

      return { meta: { changes: 1 } };
    }

    if (normalizedSql.startsWith('update gtm_replies set ')) {
      const replyId = String(boundValues[boundValues.length - 1]);
      const reply = this.replies.get(replyId);
      if (!reply) {
        return { meta: { changes: 0 } };
      }

      const assignmentsFragment = normalizedSql
        .replace('update gtm_replies set ', '')
        .replace(' where id = ?', '');
      const assignments = assignmentsFragment.split(',').map((assignment) => assignment.trim());

      for (const [index, assignment] of assignments.entries()) {
        const column = assignment.replace(' = ?', '');
        reply[column] = boundValues[index] ?? null;
      }

      return { meta: { changes: 1 } };
    }

    if (normalizedSql.startsWith('insert into gtm_sync_cursor')) {
      const [id, lastSyncedAt, updatedAt] = boundValues;
      this.syncCursor = {
        id: String(id),
        last_synced_at: String(lastSyncedAt),
        updated_at: String(updatedAt),
      };

      return { meta: { changes: 1 } };
    }

    throw new Error('Unhandled run SQL in GTM store test fake: ' + normalizedSql);
  }

  async first(sql, boundValues) {
    const normalizedSql = this.normalizeSql(sql);

    if (normalizedSql === 'select id from gtm_leads where id = ? limit 1') {
      const lead = this.leads.get(String(boundValues[0]));
      return lead ? { id: lead.id } : null;
    }

    if (
      normalizedSql.startsWith(
        'select id, name, email, phone, status, touches_sent, last_stage_index, last_sent_at, stopped_at, created_at, metadata from gtm_leads where id = ? limit 1'
      )
    ) {
      const lead = this.leads.get(String(boundValues[0]));
      return lead ? this.cloneLeadRow(lead) : null;
    }

    if (
      normalizedSql.startsWith(
        'select id, name, email, phone, status, touches_sent, last_stage_index, last_sent_at, stopped_at, created_at, metadata from gtm_leads where lower(email) = lower(?) order by created_at asc limit 1'
      )
    ) {
      const normalizedEmail = String(boundValues[0]).toLowerCase();
      const lead =
        Array.from(this.leads.values()).find(
          (candidate) => candidate.email.toLowerCase() === normalizedEmail
        ) ?? null;
      return lead ? this.cloneLeadRow(lead) : null;
    }

    if (
      normalizedSql ===
      'select id, last_synced_at, updated_at from gtm_sync_cursor where id = ? limit 1'
    ) {
      return this.syncCursor;
    }

    throw new Error('Unhandled first SQL in GTM store test fake: ' + normalizedSql);
  }

  async all(sql, boundValues) {
    const normalizedSql = this.normalizeSql(sql);

    if (
      normalizedSql ===
      'select id, lead_id, stage_index, sent_at, dry_run, result, message_id from gtm_touchpoints where lead_id = ? order by sent_at asc'
    ) {
      const leadId = String(boundValues[0]);
      const results = Array.from(this.touchpoints.values())
        .filter((touchpoint) => touchpoint.lead_id === leadId)
        .sort((left, right) => left.sent_at.localeCompare(right.sent_at));

      return { results };
    }

    if (
      normalizedSql ===
      'select id, name, email, phone, status, touches_sent, last_stage_index, last_sent_at, stopped_at, created_at, metadata from gtm_leads where status = ? order by created_at asc'
    ) {
      const status = String(boundValues[0]);
      const results = Array.from(this.leads.values())
        .filter((lead) => lead.status === status)
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map((lead) => this.cloneLeadRow(lead));

      return { results };
    }

    if (normalizedSql.includes('from gtm_leads left join (')) {
      const status = String(boundValues[0]);
      const results = Array.from(this.leads.values())
        .filter((lead) => lead.status === status)
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map((lead) => ({
          ...this.cloneLeadRow(lead),
          latest_touchpoint_sent_at: this.latestTouchpointSentAt(lead.id),
        }));

      return { results };
    }

    if (
      normalizedSql ===
      'select id, lead_id, from_email, subject, body_snippet, received_at, conversation_id, classification, sequence_stopped, raw_provider_id, created_at from gtm_replies order by received_at desc limit ?'
    ) {
      const limit = Number(boundValues[0]);
      const results = Array.from(this.replies.values())
        .sort((left, right) => right.received_at.localeCompare(left.received_at))
        .slice(0, limit)
        .map((reply) => this.cloneReplyRow(reply));

      return { results };
    }

    if (
      normalizedSql ===
      'select id, lead_id, from_email, subject, body_snippet, received_at, conversation_id, classification, sequence_stopped, raw_provider_id, created_at from gtm_replies where lead_id is not null order by received_at desc limit ?'
    ) {
      const limit = Number(boundValues[0]);
      const results = Array.from(this.replies.values())
        .filter((reply) => reply.lead_id !== null)
        .sort((left, right) => right.received_at.localeCompare(left.received_at))
        .slice(0, limit)
        .map((reply) => this.cloneReplyRow(reply));

      return { results };
    }

    if (
      normalizedSql ===
      'select id, lead_id, from_email, subject, body_snippet, received_at, conversation_id, classification, sequence_stopped, raw_provider_id, created_at from gtm_replies where lead_id = ? order by received_at desc'
    ) {
      const leadId = String(boundValues[0]);
      const results = Array.from(this.replies.values())
        .filter((reply) => reply.lead_id === leadId)
        .sort((left, right) => right.received_at.localeCompare(left.received_at))
        .map((reply) => this.cloneReplyRow(reply));

      return { results };
    }

    throw new Error('Unhandled all SQL in GTM store test fake: ' + normalizedSql);
  }
}

let leadCounter = 0;
let replyCounter = 0;
let touchpointCounter = 0;

function createStore(db) {
  return new DurableLeadStore(db);
}

function buildLead(overrides = {}) {
  leadCounter += 1;

  return {
    id: 'lead-' + leadCounter,
    name: 'Lead ' + leadCounter,
    email: 'lead-' + leadCounter + '@example.com',
    phone: '+13125550' + String(100 + leadCounter),
    createdAt: '2026-04-' + String(10 + leadCounter).padStart(2, '0') + 'T00:00:00.000Z',
    metadata: { source: 'missed-call', attempt: leadCounter },
    ...overrides,
  };
}

function buildTouchpoint(overrides = {}) {
  touchpointCounter += 1;

  return {
    id: 'touchpoint-' + touchpointCounter,
    lead_id: 'lead-1',
    stage_index: 0,
    sent_at: new Date().toISOString(),
    dry_run: true,
    result: 'success',
    message_id: 'message-' + touchpointCounter,
    ...overrides,
  };
}

function buildReply(overrides = {}) {
  replyCounter += 1;

  return {
    id: 'reply-' + replyCounter,
    lead_id: null,
    from_email: 'lead-' + replyCounter + '@example.com',
    subject: 'Re: missed call',
    body_snippet: 'Thanks for the follow-up.',
    received_at: '2026-04-' + String(10 + replyCounter).padStart(2, '0') + 'T12:00:00.000Z',
    conversation_id: 'conversation-' + replyCounter,
    classification: 'unknown',
    sequence_stopped: false,
    raw_provider_id: 'provider-reply-' + replyCounter,
    created_at: '2026-04-' + String(10 + replyCounter).padStart(2, '0') + 'T12:00:01.000Z',
    ...overrides,
  };
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

test('createLead inserts a pending lead and getLeadById returns the parsed record', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const lead = buildLead();

  assert.deepEqual(await store.createLead(lead), { ok: true, value: undefined });
  assert.deepEqual(await store.getLeadById(lead.id), {
    ok: true,
    value: {
      ...lead,
      status: 'pending',
      touches_sent: 0,
    },
  });
});

test('createLead returns a result error when the lead id already exists', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const lead = buildLead();

  await store.createLead(lead);

  assert.deepEqual(await store.createLead(lead), {
    ok: false,
    error: 'Lead already exists',
  });
});

test('updateLead only changes the provided fields', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const lead = buildLead();
  const lastSentAt = '2026-04-14T10:00:00.000Z';

  await store.createLead(lead);

  assert.deepEqual(
    await store.updateLead(lead.id, {
      status: 'active',
      touches_sent: 1,
      last_stage_index: 0,
      last_sent_at: lastSentAt,
    }),
    { ok: true, value: undefined }
  );

  assert.deepEqual(await store.getLeadById(lead.id), {
    ok: true,
    value: {
      ...lead,
      status: 'active',
      touches_sent: 1,
      last_stage_index: 0,
      last_sent_at: lastSentAt,
    },
  });
});

test('getLeadById returns null when no lead exists', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);

  assert.deepEqual(await store.getLeadById('missing-lead'), {
    ok: true,
    value: null,
  });
});

test('listLeadsByStatus returns all leads with the requested status', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const firstLead = buildLead({ createdAt: '2026-04-10T00:00:00.000Z' });
  const secondLead = buildLead({ createdAt: '2026-04-11T00:00:00.000Z' });
  const repliedLead = buildLead({ createdAt: '2026-04-12T00:00:00.000Z' });

  await store.createLead(firstLead);
  await store.createLead(secondLead);
  await store.createLead(repliedLead);

  await store.updateLead(firstLead.id, { status: 'active' });
  await store.updateLead(secondLead.id, { status: 'active' });
  await store.updateLead(repliedLead.id, { status: 'replied' });

  const result = await store.listLeadsByStatus('active');
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.map((lead) => lead.id),
    [firstLead.id, secondLead.id]
  );
});

test('listLeadsReadyForNextAction uses touchpoint recency and the provided sequence delays', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const noTouchLead = buildLead({ createdAt: '2026-04-10T00:00:00.000Z' });
  const oldTouchLead = buildLead({ createdAt: '2026-04-11T00:00:00.000Z' });
  const recentTouchLead = buildLead({ createdAt: '2026-04-12T00:00:00.000Z' });
  const exhaustedLead = buildLead({ createdAt: '2026-04-13T00:00:00.000Z' });

  await store.createLead(noTouchLead);
  await store.createLead(oldTouchLead);
  await store.createLead(recentTouchLead);
  await store.createLead(exhaustedLead);

  await store.updateLead(noTouchLead.id, { status: 'active' });
  await store.updateLead(oldTouchLead.id, {
    status: 'active',
    touches_sent: 1,
    last_stage_index: 0,
    last_sent_at: hoursAgo(30),
  });
  await store.updateLead(recentTouchLead.id, {
    status: 'active',
    touches_sent: 1,
    last_stage_index: 0,
    last_sent_at: hoursAgo(2),
  });
  await store.updateLead(exhaustedLead.id, {
    status: 'active',
    touches_sent: 3,
    last_stage_index: 2,
    last_sent_at: hoursAgo(100),
  });

  await store.recordTouchpoint(
    buildTouchpoint({
      lead_id: oldTouchLead.id,
      sent_at: hoursAgo(30),
    })
  );
  await store.recordTouchpoint(
    buildTouchpoint({
      lead_id: recentTouchLead.id,
      sent_at: hoursAgo(2),
    })
  );
  await store.recordTouchpoint(
    buildTouchpoint({
      lead_id: exhaustedLead.id,
      stage_index: 2,
      sent_at: hoursAgo(100),
    })
  );

  const result = await store.listLeadsReadyForNextAction(DEFAULT_SEQUENCE);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.map((lead) => lead.id),
    [noTouchLead.id, oldTouchLead.id]
  );
});

test('recordTouchpoint persists dry_run as a 0 or 1 integer in the durable store', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const lead = buildLead();
  const touchpoint = buildTouchpoint({
    lead_id: lead.id,
    dry_run: true,
    message_id: 'message-123',
  });

  await store.createLead(lead);

  assert.deepEqual(await store.recordTouchpoint(touchpoint), {
    ok: true,
    value: undefined,
  });

  assert.deepEqual(db.getTouchpoint(touchpoint.id), {
    id: touchpoint.id,
    lead_id: touchpoint.lead_id,
    stage_index: 0,
    sent_at: touchpoint.sent_at,
    dry_run: 1,
    result: 'success',
    message_id: 'message-123',
  });
});

test('listTouchpointsByLeadId returns touchpoints with dry_run cast back to boolean', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const lead = buildLead();
  const firstTouchpoint = buildTouchpoint({
    lead_id: lead.id,
    sent_at: '2026-04-14T09:00:00.000Z',
    dry_run: true,
    message_id: null,
  });
  const secondTouchpoint = buildTouchpoint({
    lead_id: lead.id,
    stage_index: 1,
    sent_at: '2026-04-14T10:00:00.000Z',
    dry_run: false,
    result: 'error',
    message_id: 'message-456',
  });

  await store.createLead(lead);
  await store.recordTouchpoint(firstTouchpoint);
  await store.recordTouchpoint(secondTouchpoint);

  assert.deepEqual(await store.listTouchpointsByLeadId(lead.id), {
    ok: true,
    value: [firstTouchpoint, secondTouchpoint],
  });
});

test('markStopped stores the terminal status and stopped_at timestamp', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const lead = buildLead();
  const stoppedAt = '2026-04-14T12:00:00.000Z';

  await store.createLead(lead);
  await store.updateLead(lead.id, { status: 'active' });

  assert.deepEqual(await store.markStopped(lead.id, 'opted_out', stoppedAt), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(await store.markStopped(lead.id, 'active', stoppedAt), {
    ok: false,
    error: 'Invalid stop reason',
  });

  assert.deepEqual(await store.getLeadById(lead.id), {
    ok: true,
    value: {
      ...lead,
      status: 'opted_out',
      touches_sent: 0,
      stopped_at: stoppedAt,
    },
  });
});

test('createReply, updateReply, and listReplies persist GTM inbox replies in descending order', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);
  const lead = buildLead({ email: 'Jordan@Example.com' });
  const olderReply = buildReply({
    lead_id: lead.id,
    from_email: 'jordan@example.com',
    received_at: '2026-04-14T10:00:00.000Z',
  });
  const newerReply = buildReply({
    from_email: 'new-lead@example.com',
    received_at: '2026-04-14T12:00:00.000Z',
  });

  await store.createLead(lead);

  assert.deepEqual(await store.createReply(olderReply), {
    ok: true,
    value: 'created',
  });
  assert.deepEqual(await store.createReply(olderReply), {
    ok: true,
    value: 'exists',
  });
  assert.deepEqual(await store.createReply(newerReply), {
    ok: true,
    value: 'created',
  });
  assert.deepEqual(await store.updateReply(olderReply.id, {
    classification: 'reply_detected',
    sequence_stopped: true,
  }), {
    ok: true,
    value: undefined,
  });

  assert.deepEqual(await store.findLeadByEmail('jordan@example.com'), {
    ok: true,
    value: {
      ...lead,
      status: 'pending',
      touches_sent: 0,
    },
  });
  assert.deepEqual(await store.listReplies(10, false), {
    ok: true,
    value: [
      newerReply,
      {
        ...olderReply,
        classification: 'reply_detected',
        sequence_stopped: true,
      },
    ],
  });
  assert.deepEqual(await store.listReplies(10, true), {
    ok: true,
    value: [
      {
        ...olderReply,
        classification: 'reply_detected',
        sequence_stopped: true,
      },
    ],
  });
  assert.deepEqual(await store.listRepliesByLeadId(lead.id), {
    ok: true,
    value: [
      {
        ...olderReply,
        classification: 'reply_detected',
        sequence_stopped: true,
      },
    ],
  });
});

test('getSyncCursor and setSyncCursor persist the inbox sync cursor', async () => {
  const db = new FakeD1Database();
  const store = createStore(db);

  assert.deepEqual(await store.getSyncCursor(), {
    ok: true,
    value: null,
  });
  assert.deepEqual(await store.setSyncCursor('2026-04-16T12:00:00.000Z', '2026-04-16T12:01:00.000Z'), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(await store.getSyncCursor(), {
    ok: true,
    value: {
      id: 'gtm-reply-cursor',
      last_synced_at: '2026-04-16T12:00:00.000Z',
      updated_at: '2026-04-16T12:01:00.000Z',
    },
  });
});

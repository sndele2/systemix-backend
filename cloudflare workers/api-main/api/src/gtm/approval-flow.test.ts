// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { DurableLeadStore } from './lead-store.ts';
import { ReplyClassifier } from './reply-classifier.ts';
import { SequenceEngine } from './sequence-engine.ts';
import { GTMService } from './service.ts';
import { parseOwnerCommand, resolveGtmApprovalOwnerCommand } from '../webhooks/twilioSms.ts';

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

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

class FakeGtmD1Database {
  constructor() {
    this.leads = new Map();
    this.touchpoints = new Map();
    this.approvals = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  approvalByCode(code) {
    return (
      Array.from(this.approvals.values()).find(
        (approval) => approval.approval_code.toUpperCase() === String(code).toUpperCase()
      ) ?? null
    );
  }

  latestApprovalByProposal(leadId, stageIndex, proposalHash) {
    return (
      Array.from(this.approvals.values())
        .filter(
          (approval) =>
            approval.lead_id === String(leadId) &&
            approval.stage_index === Number(stageIndex) &&
            approval.proposal_hash === String(proposalHash)
        )
        .sort((left, right) => right.requested_at.localeCompare(left.requested_at))[0] ?? null
    );
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

  cloneApprovalRow(approval) {
    return {
      id: approval.id,
      approval_code: approval.approval_code,
      lead_id: approval.lead_id,
      stage_index: approval.stage_index,
      proposal_hash: approval.proposal_hash,
      subject: approval.subject,
      body: approval.body,
      status: approval.status,
      requested_at: approval.requested_at,
      notified_at: approval.notified_at ?? null,
      decision_at: approval.decision_at ?? null,
      decided_by_phone: approval.decided_by_phone ?? null,
      executed_at: approval.executed_at ?? null,
    };
  }

  cloneTouchpointRow(touchpoint) {
    return {
      id: touchpoint.id,
      lead_id: touchpoint.lead_id,
      stage_index: touchpoint.stage_index,
      sent_at: touchpoint.sent_at,
      dry_run: touchpoint.dry_run,
      result: touchpoint.result,
      message_id: touchpoint.message_id,
    };
  }

  async run(sql, boundValues) {
    const normalized = normalizeSql(sql);

    if (normalized.startsWith('insert into gtm_leads')) {
      const [
        id,
        name,
        email,
        phone,
        status,
        touchesSent,
        lastStageIndex,
        lastSentAt,
        stoppedAt,
        createdAt,
        metadata,
      ] = boundValues;

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

    if (normalized.startsWith('update gtm_leads set ')) {
      const leadId = String(boundValues[boundValues.length - 1]);
      const lead = this.leads.get(leadId);
      if (!lead) {
        return { meta: { changes: 0 } };
      }

      const assignmentsFragment = normalized
        .replace('update gtm_leads set ', '')
        .replace(' where id = ?', '');
      const assignments = assignmentsFragment.split(',').map((assignment) => assignment.trim());

      for (const [index, assignment] of assignments.entries()) {
        const column = assignment.replace(' = ?', '');
        lead[column] = boundValues[index] ?? null;
      }

      return { meta: { changes: 1 } };
    }

    if (normalized.startsWith('insert into gtm_touchpoints')) {
      const [id, leadId, stageIndex, sentAt, dryRun, result, messageId] = boundValues;

      if (this.touchpoints.has(String(id))) {
        throw new Error('UNIQUE constraint failed: gtm_touchpoints.id');
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

    if (normalized.startsWith('insert into gtm_approvals')) {
      const [
        id,
        approvalCode,
        leadId,
        stageIndex,
        proposalHash,
        subject,
        body,
        status,
        requestedAt,
        notifiedAt,
        decisionAt,
        decidedByPhone,
        executedAt,
      ] = boundValues;

      const duplicatePending = Array.from(this.approvals.values()).some(
        (approval) =>
          approval.lead_id === String(leadId) &&
          approval.stage_index === Number(stageIndex) &&
          approval.proposal_hash === String(proposalHash) &&
          approval.status === 'pending'
      );

      if (duplicatePending) {
        throw new Error(
          'UNIQUE constraint failed: gtm_approvals.lead_id, gtm_approvals.stage_index, gtm_approvals.proposal_hash'
        );
      }

      this.approvals.set(String(id), {
        id: String(id),
        approval_code: String(approvalCode),
        lead_id: String(leadId),
        stage_index: Number(stageIndex),
        proposal_hash: String(proposalHash),
        subject: String(subject),
        body: String(body),
        status: String(status),
        requested_at: String(requestedAt),
        notified_at: notifiedAt === null ? null : String(notifiedAt),
        decision_at: decisionAt === null ? null : String(decisionAt),
        decided_by_phone: decidedByPhone === null ? null : String(decidedByPhone),
        executed_at: executedAt === null ? null : String(executedAt),
      });

      return { meta: { changes: 1 } };
    }

    if (normalized === 'update gtm_approvals set notified_at = ? where id = ?') {
      const [notifiedAt, approvalId] = boundValues;
      const approval = this.approvals.get(String(approvalId));
      if (!approval) {
        return { meta: { changes: 0 } };
      }

      approval.notified_at = notifiedAt === null ? null : String(notifiedAt);
      return { meta: { changes: 1 } };
    }

    if (
      normalized ===
      'update gtm_approvals set status = ?, decision_at = ?, decided_by_phone = ? where id = ? and status = ?'
    ) {
      const [status, decisionAt, decidedByPhone, approvalId, expectedStatus] = boundValues;
      const approval = this.approvals.get(String(approvalId));
      if (!approval || approval.status !== String(expectedStatus)) {
        return { meta: { changes: 0 } };
      }

      approval.status = String(status);
      approval.decision_at = String(decisionAt);
      approval.decided_by_phone = String(decidedByPhone);
      return { meta: { changes: 1 } };
    }

    if (
      normalized ===
      'update gtm_approvals set status = ?, executed_at = ? where id = ? and status = ?'
    ) {
      const [status, executedAt, approvalId, expectedStatus] = boundValues;
      const approval = this.approvals.get(String(approvalId));
      if (!approval || approval.status !== String(expectedStatus)) {
        return { meta: { changes: 0 } };
      }

      approval.status = String(status);
      approval.executed_at = String(executedAt);
      return { meta: { changes: 1 } };
    }

    throw new Error('Unhandled run SQL in approval-flow test fake: ' + normalized);
  }

  async first(sql, boundValues) {
    const normalized = normalizeSql(sql);

    if (normalized === 'select id from gtm_leads where id = ? limit 1') {
      const lead = this.leads.get(String(boundValues[0]));
      return lead ? { id: lead.id } : null;
    }

    if (
      normalized ===
      'select id, name, email, phone, status, touches_sent, last_stage_index, last_sent_at, stopped_at, created_at, metadata from gtm_leads where id = ? limit 1'
    ) {
      const lead = this.leads.get(String(boundValues[0]));
      return lead ? this.cloneLeadRow(lead) : null;
    }

    if (
      normalized ===
      'select id, approval_code, lead_id, stage_index, proposal_hash, subject, body, status, requested_at, notified_at, decision_at, decided_by_phone, executed_at from gtm_approvals where lead_id = ? and stage_index = ? and proposal_hash = ? order by requested_at desc limit 1'
    ) {
      const approval = this.latestApprovalByProposal(boundValues[0], boundValues[1], boundValues[2]);
      return approval ? this.cloneApprovalRow(approval) : null;
    }

    if (
      normalized ===
      'select id, approval_code, lead_id, stage_index, proposal_hash, subject, body, status, requested_at, notified_at, decision_at, decided_by_phone, executed_at from gtm_approvals where upper(approval_code) = upper(?) limit 1'
    ) {
      const approval = this.approvalByCode(boundValues[0]);
      return approval ? this.cloneApprovalRow(approval) : null;
    }

    if (
      normalized ===
      'select id, approval_code, lead_id, stage_index, proposal_hash, subject, body, status, requested_at, notified_at, decision_at, decided_by_phone, executed_at from gtm_approvals where id = ? limit 1'
    ) {
      const approval = this.approvals.get(String(boundValues[0])) ?? null;
      return approval ? this.cloneApprovalRow(approval) : null;
    }

    throw new Error('Unhandled first SQL in approval-flow test fake: ' + normalized);
  }

  async all(sql, boundValues) {
    const normalized = normalizeSql(sql);

    if (
      normalized ===
      'select id, lead_id, stage_index, sent_at, dry_run, result, message_id from gtm_touchpoints where lead_id = ? order by sent_at asc'
    ) {
      const leadId = String(boundValues[0]);
      const results = Array.from(this.touchpoints.values())
        .filter((touchpoint) => touchpoint.lead_id === leadId)
        .sort((left, right) => left.sent_at.localeCompare(right.sent_at))
        .map((touchpoint) => this.cloneTouchpointRow(touchpoint));

      return { results };
    }

    throw new Error('Unhandled all SQL in approval-flow test fake: ' + normalized);
  }
}

class TestEmailClient {
  constructor() {
    this.calls = [];
    this.nextResult = {
      success: true,
      dryRun: true,
      messageId: null,
    };
    this.throwError = null;
  }

  async send(message) {
    this.calls.push(message);

    if (this.throwError) {
      throw this.throwError;
    }

    return this.nextResult;
  }
}

function buildLead(overrides = {}) {
  return {
    id: 'lead-approval-1',
    name: 'Jordan',
    email: 'jordan@example.com',
    phone: '+13125550199',
    createdAt: '2026-04-22T00:00:00.000Z',
    metadata: { source: 'missed-call' },
    ...overrides,
  };
}

function createHarness() {
  const db = new FakeGtmD1Database();
  const store = new DurableLeadStore(db);
  const emailClient = new TestEmailClient();
  const approvalNotifications = [];
  const service = new GTMService({
    store,
    emailClient,
    sequenceEngine: new SequenceEngine({ maxTouches: 3 }),
    replyClassifier: new ReplyClassifier(),
    config: {
      fromEmail: 'gtm@example.com',
      fromName: 'Systemix',
      maxTouches: 3,
      dryRun: true,
    },
    approvalHooks: {
      async requestApproval(input) {
        approvalNotifications.push(input);
      },
    },
  });

  return {
    db,
    store,
    emailClient,
    approvalNotifications,
    service,
  };
}

async function createPendingApprovalCycle() {
  const harness = createHarness();
  const lead = buildLead();

  assert.deepEqual(await harness.service.createLead(lead), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(await harness.service.startSequence(lead.id), {
    ok: true,
    value: undefined,
  });
  assert.deepEqual(await harness.service.advanceLeadSequence(lead.id), {
    ok: true,
    value: {
      action: 'skipped',
      leadId: lead.id,
      reason: 'awaiting_approval',
    },
  });

  const approval = Array.from(harness.db.approvals.values())[0];
  assert.ok(approval);

  return {
    ...harness,
    leadId: lead.id,
    approval,
  };
}

test('approval-gated GTM happy path persists pending approval, approves via owner SMS, and advances on retry', async () => {
  const harness = await createPendingApprovalCycle();

  assert.equal(harness.approvalNotifications.length, 1);
  assert.equal(harness.emailClient.calls.length, 0);
  assert.equal(harness.db.touchpoints.size, 0);

  const leadBeforeApproval = await harness.store.getLeadById(harness.leadId);
  assert.equal(leadBeforeApproval.value.touches_sent, 0);
  assert.equal(leadBeforeApproval.value.status, 'active');
  assert.equal(harness.approval.status, 'pending');

  const approvalCommand = parseOwnerCommand(`YES ${harness.approval.approval_code}`);
  assert.equal(approvalCommand.type, 'GTM_APPROVE');

  const approvalResponse = await resolveGtmApprovalOwnerCommand({
    env: { GTM_DB: harness.db },
    command: approvalCommand,
    ownerPhone: '+12175550123',
  });
  assert.match(approvalResponse, /Approved GTM action/);

  const approvedRow = harness.db.approvals.get(harness.approval.id);
  assert.equal(approvedRow.status, 'approved');
  assert.equal(typeof approvedRow.decision_at, 'string');
  assert.equal(approvedRow.executed_at, null);

  assert.deepEqual(await harness.service.advanceLeadSequence(harness.leadId), {
    ok: true,
    value: {
      action: 'skipped',
      leadId: harness.leadId,
      reason: 'dry_run',
    },
  });

  const executedRow = harness.db.approvals.get(harness.approval.id);
  const leadAfterRetry = await harness.store.getLeadById(harness.leadId);
  const touchpoints = await harness.store.listTouchpointsByLeadId(harness.leadId);

  assert.equal(executedRow.status, 'executed');
  assert.equal(typeof executedRow.executed_at, 'string');
  assert.equal(harness.emailClient.calls.length, 1);
  assert.equal(touchpoints.value.length, 1);
  assert.equal(touchpoints.value[0].result, 'skipped');
  assert.equal(leadAfterRetry.value.touches_sent, 1);
  assert.equal(leadAfterRetry.value.last_stage_index, 0);
  assert.equal(leadAfterRetry.value.status, 'active');
});

test('duplicate YES stays idempotent and does not re-resolve approval', async () => {
  const harness = await createPendingApprovalCycle();
  const approvalCommand = parseOwnerCommand(`YES ${harness.approval.approval_code}`);

  assert.match(
    await resolveGtmApprovalOwnerCommand({
      env: { GTM_DB: harness.db },
      command: approvalCommand,
      ownerPhone: '+12175550123',
    }),
    /Approved GTM action/
  );
  assert.equal(harness.db.approvals.get(harness.approval.id).status, 'approved');

  assert.equal(
    await resolveGtmApprovalOwnerCommand({
      env: { GTM_DB: harness.db },
      command: approvalCommand,
      ownerPhone: '+12175550123',
    }),
    'Approval is already approved.'
  );
});

test('NO rejection keeps the proposal blocked and unsent', async () => {
  const harness = await createPendingApprovalCycle();
  const rejectionCommand = parseOwnerCommand(`NO ${harness.approval.approval_code}`);

  assert.match(
    await resolveGtmApprovalOwnerCommand({
      env: { GTM_DB: harness.db },
      command: rejectionCommand,
      ownerPhone: '+12175550123',
    }),
    /Rejected GTM action/
  );
  assert.equal(harness.db.approvals.get(harness.approval.id).status, 'rejected');

  assert.deepEqual(await harness.service.advanceLeadSequence(harness.leadId), {
    ok: true,
    value: {
      action: 'skipped',
      leadId: harness.leadId,
      reason: 'approval_rejected',
    },
  });
  assert.equal(harness.emailClient.calls.length, 0);
  assert.equal(harness.db.touchpoints.size, 0);
});

test('unknown approval code returns a stale-code response', async () => {
  assert.equal(
    await resolveGtmApprovalOwnerCommand({
      env: { GTM_DB: new FakeGtmD1Database() },
      command: { type: 'GTM_APPROVE', approvalCode: 'UNKNOWN99' },
      ownerPhone: '+12175550123',
    }),
    'No pending GTM approval found for code UNKNOWN99.'
  );
});

test('approved proposal with send failure remains approved and does not advance lead state', async () => {
  const harness = await createPendingApprovalCycle();
  const approvalCommand = parseOwnerCommand(`YES ${harness.approval.approval_code}`);

  await resolveGtmApprovalOwnerCommand({
    env: { GTM_DB: harness.db },
    command: approvalCommand,
    ownerPhone: '+12175550123',
  });

  harness.emailClient.throwError = new Error('smtp down');

  assert.deepEqual(await harness.service.advanceLeadSequence(harness.leadId), {
    ok: false,
    error: 'Failed to send GTM email',
  });

  const approvalRow = harness.db.approvals.get(harness.approval.id);
  const lead = await harness.store.getLeadById(harness.leadId);
  const touchpoints = await harness.store.listTouchpointsByLeadId(harness.leadId);

  assert.equal(approvalRow.status, 'approved');
  assert.equal(approvalRow.executed_at, null);
  assert.equal(lead.value.touches_sent, 0);
  assert.equal(touchpoints.value.length, 1);
});

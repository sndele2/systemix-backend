// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { onboardNewLead } from './twilioLaunch.ts';

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async run() {
    return this.db.run(this.sql, this.values);
  }

  async first() {
    return this.db.first(this.sql, this.values);
  }
}

class FakeFlowDb {
  constructor(options = {}) {
    this.options = options;
    this.workflowRuns = [];
    this.workflowSteps = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  normalize(sql) {
    return sql.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async run(sql, values) {
    const normalized = this.normalize(sql);

    if (this.options.failWorkflowWrites && normalized.includes('workflow_')) {
      throw new Error('trace_write_failed');
    }

    if (normalized.startsWith('insert into workflow_runs')) {
      this.workflowRuns.push(values);
      return { meta: { changes: 1 } };
    }

    if (normalized.startsWith('insert into workflow_steps')) {
      this.workflowSteps.push(values);
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 1 } };
  }

  async first(sql) {
    const normalized = this.normalize(sql);

    if (normalized.includes('from businesses')) {
      return {
        business_number: '+18443217137',
        display_name: 'Systemix Auto',
        intake_question: 'what is your vehicle issue?',
      };
    }

    if (normalized.includes('from messages')) {
      return null;
    }

    if (normalized.includes('from missed_call_ignored_numbers')) {
      return null;
    }

    return null;
  }
}

const twilioClient = {
  async sendSms() {
    return { ok: true, sid: 'SM123', suppressed: false };
  },
};

test('onboardNewLead writes workflow run + steps on success', async () => {
  const db = new FakeFlowDb();

  const result = await onboardNewLead({
    db,
    twilioClient,
    smsFrom: '+18443217137',
    businessNumber: '+18443217137',
    callerNumber: '+15555550123',
    provider: 'twilio',
    providerCallId: 'CA123',
    callStatus: 'no-answer',
    rawStatus: 'no-answer',
    callSid: 'CA123',
    trace: {
      requestId: 'req-success',
      runId: 'run-success',
    },
  });

  assert.equal(result.ok, true);
  assert.ok(db.workflowSteps.length > 0);
  const stepNames = db.workflowSteps.map((row) => String(row[3]));
  assert.ok(stepNames.includes('outbound_sms_attempt'));
  assert.ok(stepNames.includes('outbound_sms_result'));
});

test('onboardNewLead continues when trace persistence fails', async () => {
  const db = new FakeFlowDb({ failWorkflowWrites: true });

  const result = await onboardNewLead({
    db,
    twilioClient,
    smsFrom: '+18443217137',
    businessNumber: '+18443217137',
    callerNumber: '+15555550123',
    provider: 'twilio',
    providerCallId: 'CA456',
    callStatus: 'no-answer',
    rawStatus: 'no-answer',
    callSid: 'CA456',
    trace: {
      requestId: 'req-failure-safe',
      runId: 'run-failure-safe',
    },
  });

  assert.equal(result.ok, true);
});

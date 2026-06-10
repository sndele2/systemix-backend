// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';

import { completeWorkflowRun, logWorkflowStep, startWorkflowRun } from './workflow-trace.ts';

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
}

class TraceDb {
  constructor() {
    this.workflowRuns = new Map();
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

    if (normalized.startsWith('insert into workflow_runs')) {
      const [id, requestId, workflowName, businessNumber, phoneNumber, status, source, summary, createdAt] = values;
      this.workflowRuns.set(String(id), {
        id: String(id),
        request_id: String(requestId),
        workflow_name: String(workflowName),
        business_number: businessNumber,
        phone_number: phoneNumber,
        status: String(status),
        source,
        summary,
        created_at: String(createdAt),
        completed_at: null,
      });
      return { meta: { changes: 1 } };
    }

    if (normalized.startsWith('update workflow_runs set status = ?')) {
      const [status, summary, completedAt, id] = values;
      const run = this.workflowRuns.get(String(id));
      if (!run) return { meta: { changes: 0 } };
      run.status = String(status);
      if (summary !== null) run.summary = String(summary);
      run.completed_at = String(completedAt);
      return { meta: { changes: 1 } };
    }

    if (normalized.startsWith('insert into workflow_steps')) {
      const [id, requestId, runId, stepName, status, inputJson, outputJson, errorText, latencyMs, createdAt] = values;
      this.workflowSteps.push({
        id: String(id),
        request_id: String(requestId),
        run_id: String(runId),
        step_name: String(stepName),
        status: String(status),
        input_json: inputJson,
        output_json: outputJson,
        error_text: errorText,
        latency_ms: latencyMs,
        created_at: String(createdAt),
      });
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 0 } };
  }
}

test('workflow trace helper records run + step for successful flow', async () => {
  const db = new TraceDb();

  const runId = await startWorkflowRun(db, {
    requestId: 'req-1',
    workflowName: 'missed_call_recovery',
    businessNumber: '+18443217137',
    phoneNumber: '+15555550123',
    source: 'twilio_voice_webhook',
  });

  await logWorkflowStep(db, {
    requestId: 'req-1',
    runId,
    stepName: 'inbound_webhook_received',
    input: { callSid: 'CA123' },
    output: { accepted: true },
  });

  await completeWorkflowRun(db, {
    requestId: 'req-1',
    runId,
    status: 'completed',
    summary: 'ok',
  });

  const run = db.workflowRuns.get(runId);
  assert.ok(run);
  assert.equal(run.status, 'completed');
  assert.equal(db.workflowSteps.length, 1);
  assert.equal(db.workflowSteps[0].step_name, 'inbound_webhook_received');
});

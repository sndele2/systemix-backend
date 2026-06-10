const MAX_TEXT_LENGTH = 2000;
const MAX_JSON_TEXT_LENGTH = 4000;

export interface StartWorkflowRunInput {
  requestId: string;
  workflowName: string;
  businessNumber?: string | null;
  phoneNumber?: string | null;
  source?: string | null;
  summary?: string | null;
}

export interface CompleteWorkflowRunInput {
  requestId: string;
  runId: string;
  status?: string;
  summary?: string | null;
}

export interface FailWorkflowRunInput {
  requestId: string;
  runId: string;
  errorText: string;
  summary?: string | null;
}

export interface LogWorkflowStepInput {
  requestId: string;
  runId: string;
  stepName: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string | null;
  latencyMs?: number | null;
}

function trimText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = (value || '').trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function toJsonText(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    const raw = JSON.stringify(value);
    if (typeof raw !== 'string') {
      return null;
    }

    if (raw.length <= MAX_JSON_TEXT_LENGTH) {
      return raw;
    }

    return `${raw.slice(0, Math.max(0, MAX_JSON_TEXT_LENGTH - 3)).trimEnd()}...`;
  } catch {
    return null;
  }
}

async function safeTraceWrite(task: Promise<unknown>): Promise<void> {
  try {
    await task;
  } catch {
    // Workflow tracing is best-effort and must never fail user-facing flows.
  }
}

export async function startWorkflowRun(db: D1Database, input: StartWorkflowRunInput): Promise<string> {
  const runId = crypto.randomUUID();

  await safeTraceWrite(
    db
      .prepare(
        `
        INSERT INTO workflow_runs (
          id,
          request_id,
          workflow_name,
          business_number,
          phone_number,
          status,
          source,
          summary,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .bind(
        runId,
        trimText(input.requestId, 255) || runId,
        trimText(input.workflowName, 255) || 'workflow',
        trimText(input.businessNumber, 64),
        trimText(input.phoneNumber, 64),
        'started',
        trimText(input.source, 255),
        trimText(input.summary, MAX_TEXT_LENGTH),
        new Date().toISOString()
      )
      .run()
  );

  return runId;
}

export async function completeWorkflowRun(db: D1Database, input: CompleteWorkflowRunInput): Promise<void> {
  await safeTraceWrite(
    db
      .prepare(
        `
        UPDATE workflow_runs
        SET status = ?,
            summary = COALESCE(?, summary),
            completed_at = ?
        WHERE id = ?
          AND request_id = ?
      `
      )
      .bind(
        trimText(input.status, 64) || 'completed',
        trimText(input.summary, MAX_TEXT_LENGTH),
        new Date().toISOString(),
        input.runId,
        trimText(input.requestId, 255) || input.runId
      )
      .run()
  );
}

export async function failWorkflowRun(db: D1Database, input: FailWorkflowRunInput): Promise<void> {
  await safeTraceWrite(
    db
      .prepare(
        `
        UPDATE workflow_runs
        SET status = 'failed',
            summary = COALESCE(?, summary),
            error_text = ?,
            completed_at = ?
        WHERE id = ?
          AND request_id = ?
      `
      )
      .bind(
        trimText(input.summary, MAX_TEXT_LENGTH),
        trimText(input.errorText, MAX_TEXT_LENGTH) || 'workflow_failed',
        new Date().toISOString(),
        input.runId,
        trimText(input.requestId, 255) || input.runId
      )
      .run()
  );
}

export async function logWorkflowStep(db: D1Database, input: LogWorkflowStepInput): Promise<void> {
  await safeTraceWrite(
    db
      .prepare(
        `
        INSERT INTO workflow_steps (
          id,
          request_id,
          run_id,
          step_name,
          status,
          input_json,
          output_json,
          error_text,
          latency_ms,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .bind(
        crypto.randomUUID(),
        trimText(input.requestId, 255) || input.runId,
        input.runId,
        trimText(input.stepName, 255) || 'step',
        trimText(input.status, 64) || 'success',
        toJsonText(input.input),
        toJsonText(input.output),
        trimText(input.errorText, MAX_TEXT_LENGTH),
        Number.isFinite(input.latencyMs) ? Math.max(0, Math.round(input.latencyMs as number)) : null,
        new Date().toISOString()
      )
      .run()
  );
}

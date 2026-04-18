/**
 * Implements durable GTM lead-state persistence against the GTM D1 schema.
 */
import type {
  CreateGtmReply,
  EmailStage,
  GtmReply,
  Lead,
  LeadRecord,
  LeadStatus,
  Result,
  SyncCursor,
  Touchpoint,
  TouchpointResult,
  UpdateGtmReply,
} from './types.ts';

const GTM_LOG_PREFIX = '[GTM]';
const PENDING_STATUS: LeadStatus = 'pending';
const ACTIVE_STATUS: LeadStatus = 'active';

interface LeadRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  touches_sent: number;
  last_stage_index: number | null;
  last_sent_at: string | null;
  stopped_at: string | null;
  created_at: string;
  metadata: string | null;
}

interface LeadWithLatestTouchpointRow extends LeadRow {
  latest_touchpoint_sent_at: string | null;
}

interface TouchpointRow {
  id: string;
  lead_id: string;
  stage_index: number;
  sent_at: string;
  dry_run: number;
  result: string;
  message_id: string | null;
}

interface ExistingLeadRow {
  id: string;
}

interface GtmReplyRow {
  id: string;
  lead_id: string | null;
  from_email: string;
  subject: string | null;
  body_snippet: string;
  received_at: string;
  conversation_id: string | null;
  classification: string;
  sequence_stopped: number;
  raw_provider_id: string | null;
  created_at: string;
}

interface SyncCursorRow {
  id: string;
  last_synced_at: string;
  updated_at: string;
}

export interface LeadStore {
  createLead(lead: Lead): Promise<Result<void>>;
  createReply(reply: CreateGtmReply): Promise<Result<'created' | 'exists'>>;
  findLeadByEmail(email: string): Promise<Result<LeadRecord | null>>;
  getSyncCursor(): Promise<Result<SyncCursor | null>>;
  updateLead(leadId: string, patch: Partial<LeadRecord>): Promise<Result<void>>;
  updateReply(replyId: string, patch: UpdateGtmReply): Promise<Result<void>>;
  getLeadById(leadId: string): Promise<Result<LeadRecord | null>>;
  listLeadsByStatus(status: LeadStatus): Promise<Result<LeadRecord[]>>;
  listReplies(limit: number, matchedOnly: boolean): Promise<Result<GtmReply[]>>;
  listRepliesByLeadId(leadId: string): Promise<Result<GtmReply[]>>;
  listTouchpointsByLeadId(leadId: string): Promise<Result<Touchpoint[]>>;
  listLeadsReadyForNextAction(sequence: ReadonlyArray<EmailStage>): Promise<Result<LeadRecord[]>>;
  recordTouchpoint(touchpoint: Touchpoint): Promise<Result<void>>;
  markStopped(leadId: string, reason: LeadStatus, stoppedAt: string): Promise<Result<void>>;
  setSyncCursor(lastSyncedAt: string, updatedAt: string): Promise<Result<void>>;
}

function succeed<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

function logStoreError(operation: string, error: unknown, context: Record<string, unknown> = {}): void {
  console.error(GTM_LOG_PREFIX + ' lead-store operation failed', {
    operation,
    ...context,
    error: error instanceof Error ? error.message : String(error),
  });
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLeadStatus(value: string): value is LeadStatus {
  switch (value) {
    case 'pending':
    case 'active':
    case 'replied':
    case 'converted':
    case 'exhausted':
    case 'opted_out':
    case 'error':
      return true;
    default:
      return false;
  }
}

function isStopReason(value: LeadStatus): boolean {
  switch (value) {
    case 'replied':
    case 'converted':
    case 'exhausted':
    case 'opted_out':
    case 'error':
      return true;
    case 'pending':
    case 'active':
    default:
      return false;
  }
}

function isTouchpointResult(value: string): value is TouchpointResult {
  switch (value) {
    case 'success':
    case 'error':
    case 'skipped':
      return true;
    default:
      return false;
  }
}

function isStageIndex(value: number): value is EmailStage['stageIndex'] {
  return value === 0 || value === 1 || value === 2;
}

function isUniqueConstraintError(
  error: unknown,
  table: 'gtm_leads' | 'gtm_touchpoints' | 'gtm_replies'
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('UNIQUE constraint failed: ' + table + '.id');
}

function validateTouchesSent(value: number): Result<number> {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    return fail('touches_sent must be an integer between 0 and 3');
  }

  return succeed(value);
}

function serializeMetadata(metadata: Lead['metadata'] | null | undefined): Result<string | null> {
  if (metadata === undefined || metadata === null) {
    return succeed(null);
  }

  try {
    return succeed(JSON.stringify(metadata));
  } catch (error) {
    logStoreError('serializeMetadata', error);
    return fail('Failed to serialize lead metadata');
  }
}

function parseMetadata(raw: string | null, leadId: string): Result<Record<string, unknown> | undefined> {
  if (raw === null) {
    return succeed(undefined);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      logStoreError('parseMetadata', new Error('metadata is not an object'), { leadId });
      return fail('Failed to parse lead metadata');
    }

    return succeed(parsed);
  } catch (error) {
    logStoreError('parseMetadata', error, { leadId });
    return fail('Failed to parse lead metadata');
  }
}

function mapLeadRow(row: LeadRow): Result<LeadRecord> {
  if (!isLeadStatus(row.status)) {
    return fail('Invalid lead status in durable store');
  }

  const touchesSentResult = validateTouchesSent(row.touches_sent);
  if (!touchesSentResult.ok) {
    return touchesSentResult;
  }

  if (row.last_stage_index !== null && !isStageIndex(row.last_stage_index)) {
    return fail('Invalid last_stage_index in durable store');
  }

  const metadataResult = parseMetadata(row.metadata, row.id);
  if (!metadataResult.ok) {
    return metadataResult;
  }

  const record: LeadRecord = {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    status: row.status,
    touches_sent: touchesSentResult.value,
  };

  if (row.phone !== null) {
    record.phone = row.phone;
  }

  if (metadataResult.value !== undefined) {
    record.metadata = metadataResult.value;
  }

  if (row.last_stage_index !== null) {
    record.last_stage_index = row.last_stage_index;
  }

  if (row.last_sent_at !== null) {
    record.last_sent_at = row.last_sent_at;
  }

  if (row.stopped_at !== null) {
    record.stopped_at = row.stopped_at;
  }

  return succeed(record);
}

function mapTouchpointRow(row: TouchpointRow): Result<Touchpoint> {
  if (!isStageIndex(row.stage_index)) {
    return fail('Invalid touchpoint stage_index in durable store');
  }

  if (!isTouchpointResult(row.result)) {
    return fail('Invalid touchpoint result in durable store');
  }

  if (row.dry_run !== 0 && row.dry_run !== 1) {
    return fail('Invalid touchpoint dry_run flag in durable store');
  }

  return succeed({
    id: row.id,
    lead_id: row.lead_id,
    stage_index: row.stage_index,
    sent_at: row.sent_at,
    dry_run: row.dry_run === 1,
    result: row.result,
    message_id: row.message_id,
  });
}

function mapReplyRow(row: GtmReplyRow): Result<GtmReply> {
  if (row.sequence_stopped !== 0 && row.sequence_stopped !== 1) {
    return fail('Invalid reply sequence_stopped flag in durable store');
  }

  return succeed({
    id: row.id,
    lead_id: row.lead_id,
    from_email: row.from_email,
    subject: row.subject,
    body_snippet: row.body_snippet,
    received_at: row.received_at,
    conversation_id: row.conversation_id,
    classification: row.classification,
    sequence_stopped: row.sequence_stopped === 1,
    raw_provider_id: row.raw_provider_id,
    created_at: row.created_at,
  });
}

export class DurableLeadStore implements LeadStore {
  readonly database: D1Database;

  constructor(database: D1Database) {
    this.database = database;
  }

  async createLead(lead: Lead): Promise<Result<void>> {
    const existingLeadResult = await this.getExistingLead(lead.id);
    if (!existingLeadResult.ok) {
      return existingLeadResult;
    }

    if (existingLeadResult.value !== null) {
      return fail('Lead already exists');
    }

    const metadataResult = serializeMetadata(lead.metadata);
    if (!metadataResult.ok) {
      return metadataResult;
    }

    try {
      await this.database
        .prepare(
          'INSERT INTO gtm_leads ' +
            '(id, name, email, phone, status, touches_sent, last_stage_index, last_sent_at, stopped_at, created_at, metadata) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          lead.id,
          lead.name,
          lead.email,
          lead.phone ?? null,
          PENDING_STATUS,
          0,
          null,
          null,
          null,
          lead.createdAt,
          metadataResult.value
        )
        .run();

      return succeed(undefined);
    } catch (error) {
      if (isUniqueConstraintError(error, 'gtm_leads')) {
        return fail('Lead already exists');
      }

      logStoreError('createLead', error, { leadId: lead.id });
      return fail('Failed to create GTM lead');
    }
  }

  async createReply(reply: CreateGtmReply): Promise<Result<'created' | 'exists'>> {
    try {
      const result = await this.database
        .prepare(
          'INSERT OR IGNORE INTO gtm_replies ' +
            '(id, lead_id, from_email, subject, body_snippet, received_at, conversation_id, classification, sequence_stopped, raw_provider_id, created_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          reply.id,
          reply.lead_id,
          reply.from_email,
          reply.subject,
          reply.body_snippet,
          reply.received_at,
          reply.conversation_id,
          reply.classification,
          reply.sequence_stopped ? 1 : 0,
          reply.raw_provider_id,
          reply.created_at
        )
        .run();

      return succeed(result.meta.changes > 0 ? 'created' : 'exists');
    } catch (error) {
      if (isUniqueConstraintError(error, 'gtm_replies')) {
        return succeed('exists');
      }

      logStoreError('createReply', error, { replyId: reply.id });
      return fail('Failed to create GTM reply');
    }
  }

  async findLeadByEmail(email: string): Promise<Result<LeadRecord | null>> {
    try {
      const row = await this.database
        .prepare(
          'SELECT id, name, email, phone, status, touches_sent, last_stage_index, last_sent_at, stopped_at, created_at, metadata ' +
            'FROM gtm_leads WHERE lower(email) = lower(?) ORDER BY created_at ASC LIMIT 1'
        )
        .bind(email)
        .first<LeadRow>();

      if (row === null) {
        return succeed(null);
      }

      return mapLeadRow(row);
    } catch (error) {
      logStoreError('findLeadByEmail', error, { email });
      return fail('Failed to find GTM lead by email');
    }
  }

  async getSyncCursor(): Promise<Result<SyncCursor | null>> {
    try {
      const row = await this.database
        .prepare(
          'SELECT id, last_synced_at, updated_at FROM gtm_sync_cursor WHERE id = ? LIMIT 1'
        )
        .bind('gtm-reply-cursor')
        .first<SyncCursorRow>();

      if (row === null) {
        return succeed(null);
      }

      return succeed({
        id: row.id,
        last_synced_at: row.last_synced_at,
        updated_at: row.updated_at,
      });
    } catch (error) {
      logStoreError('getSyncCursor', error);
      return fail('Failed to load GTM sync cursor');
    }
  }

  async updateLead(leadId: string, patch: Partial<LeadRecord>): Promise<Result<void>> {
    if (hasOwn(patch, 'id')) {
      return fail('Lead id cannot be updated');
    }

    const existingLeadResult = await this.getExistingLead(leadId);
    if (!existingLeadResult.ok) {
      return existingLeadResult;
    }

    if (existingLeadResult.value === null) {
      return fail('Lead not found');
    }

    const assignments: string[] = [];
    const values: Array<number | string | null> = [];

    if (hasOwn(patch, 'name')) {
      if (typeof patch.name !== 'string') {
        return fail('Lead name must be a string');
      }

      assignments.push('name = ?');
      values.push(patch.name);
    }

    if (hasOwn(patch, 'email')) {
      if (typeof patch.email !== 'string') {
        return fail('Lead email must be a string');
      }

      assignments.push('email = ?');
      values.push(patch.email);
    }

    if (hasOwn(patch, 'phone')) {
      if (patch.phone !== undefined && typeof patch.phone !== 'string') {
        return fail('Lead phone must be a string when provided');
      }

      assignments.push('phone = ?');
      values.push(patch.phone ?? null);
    }

    if (hasOwn(patch, 'createdAt')) {
      if (typeof patch.createdAt !== 'string') {
        return fail('createdAt must be a string');
      }

      assignments.push('created_at = ?');
      values.push(patch.createdAt);
    }

    if (hasOwn(patch, 'metadata')) {
      const metadataResult = serializeMetadata(patch.metadata);
      if (!metadataResult.ok) {
        return metadataResult;
      }

      assignments.push('metadata = ?');
      values.push(metadataResult.value);
    }

    if (hasOwn(patch, 'status')) {
      if (typeof patch.status !== 'string' || !isLeadStatus(patch.status)) {
        return fail('Invalid lead status');
      }

      assignments.push('status = ?');
      values.push(patch.status);
    }

    if (hasOwn(patch, 'touches_sent')) {
      if (typeof patch.touches_sent !== 'number') {
        return fail('touches_sent must be a number');
      }

      const touchesSentResult = validateTouchesSent(patch.touches_sent);
      if (!touchesSentResult.ok) {
        return touchesSentResult;
      }

      assignments.push('touches_sent = ?');
      values.push(touchesSentResult.value);
    }

    if (hasOwn(patch, 'last_stage_index')) {
      if (patch.last_stage_index !== undefined && !isStageIndex(patch.last_stage_index)) {
        return fail('last_stage_index must be 0, 1, or 2 when provided');
      }

      assignments.push('last_stage_index = ?');
      values.push(patch.last_stage_index ?? null);
    }

    if (hasOwn(patch, 'last_sent_at')) {
      if (patch.last_sent_at !== undefined && typeof patch.last_sent_at !== 'string') {
        return fail('last_sent_at must be a string when provided');
      }

      assignments.push('last_sent_at = ?');
      values.push(patch.last_sent_at ?? null);
    }

    if (hasOwn(patch, 'stopped_at')) {
      if (patch.stopped_at !== undefined && typeof patch.stopped_at !== 'string') {
        return fail('stopped_at must be a string when provided');
      }

      assignments.push('stopped_at = ?');
      values.push(patch.stopped_at ?? null);
    }

    if (assignments.length === 0) {
      return succeed(undefined);
    }

    try {
      await this.database
        .prepare('UPDATE gtm_leads SET ' + assignments.join(', ') + ' WHERE id = ?')
        .bind(...values, leadId)
        .run();

      return succeed(undefined);
    } catch (error) {
      logStoreError('updateLead', error, { leadId });
      return fail('Failed to update GTM lead');
    }
  }

  async updateReply(replyId: string, patch: UpdateGtmReply): Promise<Result<void>> {
    const assignments: string[] = [];
    const values: Array<number | string | null> = [];

    if (hasOwn(patch, 'lead_id')) {
      if (patch.lead_id !== null && patch.lead_id !== undefined && typeof patch.lead_id !== 'string') {
        return fail('lead_id must be a string or null when provided');
      }

      assignments.push('lead_id = ?');
      values.push(patch.lead_id ?? null);
    }

    if (hasOwn(patch, 'classification')) {
      if (typeof patch.classification !== 'string' || patch.classification.trim().length === 0) {
        return fail('classification must be a non-empty string');
      }

      assignments.push('classification = ?');
      values.push(patch.classification);
    }

    if (hasOwn(patch, 'sequence_stopped')) {
      if (typeof patch.sequence_stopped !== 'boolean') {
        return fail('sequence_stopped must be a boolean');
      }

      assignments.push('sequence_stopped = ?');
      values.push(patch.sequence_stopped ? 1 : 0);
    }

    if (assignments.length === 0) {
      return succeed(undefined);
    }

    try {
      const result = await this.database
        .prepare('UPDATE gtm_replies SET ' + assignments.join(', ') + ' WHERE id = ?')
        .bind(...values, replyId)
        .run();

      if (result.meta.changes === 0) {
        return fail('Reply not found');
      }

      return succeed(undefined);
    } catch (error) {
      logStoreError('updateReply', error, { replyId });
      return fail('Failed to update GTM reply');
    }
  }

  async getLeadById(leadId: string): Promise<Result<LeadRecord | null>> {
    try {
      const row = await this.database
        .prepare(
          'SELECT id, name, email, phone, status, touches_sent, last_stage_index, last_sent_at, stopped_at, created_at, metadata ' +
            'FROM gtm_leads WHERE id = ? LIMIT 1'
        )
        .bind(leadId)
        .first<LeadRow>();

      if (row === null) {
        return succeed(null);
      }

      return mapLeadRow(row);
    } catch (error) {
      logStoreError('getLeadById', error, { leadId });
      return fail('Failed to load GTM lead');
    }
  }

  async listReplies(limit: number, matchedOnly: boolean): Promise<Result<GtmReply[]>> {
    const sql =
      'SELECT id, lead_id, from_email, subject, body_snippet, received_at, conversation_id, classification, sequence_stopped, raw_provider_id, created_at ' +
      'FROM gtm_replies ' +
      (matchedOnly ? 'WHERE lead_id IS NOT NULL ' : '') +
      'ORDER BY received_at DESC LIMIT ?';

    try {
      const result = await this.database.prepare(sql).bind(limit).all<GtmReplyRow>();
      return this.mapReplyRows(result.results);
    } catch (error) {
      logStoreError('listReplies', error, { limit, matchedOnly });
      return fail('Failed to list GTM replies');
    }
  }

  async listRepliesByLeadId(leadId: string): Promise<Result<GtmReply[]>> {
    try {
      const result = await this.database
        .prepare(
          'SELECT id, lead_id, from_email, subject, body_snippet, received_at, conversation_id, classification, sequence_stopped, raw_provider_id, created_at ' +
            'FROM gtm_replies WHERE lead_id = ? ORDER BY received_at DESC'
        )
        .bind(leadId)
        .all<GtmReplyRow>();

      return this.mapReplyRows(result.results);
    } catch (error) {
      logStoreError('listRepliesByLeadId', error, { leadId });
      return fail('Failed to list GTM replies by lead');
    }
  }

  async listLeadsByStatus(status: LeadStatus): Promise<Result<LeadRecord[]>> {
    try {
      const result = await this.database
        .prepare(
          'SELECT id, name, email, phone, status, touches_sent, last_stage_index, last_sent_at, stopped_at, created_at, metadata ' +
            'FROM gtm_leads WHERE status = ? ORDER BY created_at ASC'
        )
        .bind(status)
        .all<LeadRow>();

      return this.mapLeadRows(result.results);
    } catch (error) {
      logStoreError('listLeadsByStatus', error, { status });
      return fail('Failed to list GTM leads');
    }
  }

  async listTouchpointsByLeadId(leadId: string): Promise<Result<Touchpoint[]>> {
    try {
      const result = await this.database
        .prepare(
          'SELECT id, lead_id, stage_index, sent_at, dry_run, result, message_id ' +
            'FROM gtm_touchpoints WHERE lead_id = ? ORDER BY sent_at ASC'
        )
        .bind(leadId)
        .all<TouchpointRow>();

      const touchpoints: Touchpoint[] = [];

      for (const row of result.results) {
        const mappedTouchpointResult = mapTouchpointRow(row);
        if (!mappedTouchpointResult.ok) {
          return mappedTouchpointResult;
        }

        touchpoints.push(mappedTouchpointResult.value);
      }

      return succeed(touchpoints);
    } catch (error) {
      logStoreError('listTouchpointsByLeadId', error, { leadId });
      return fail('Failed to list GTM touchpoints');
    }
  }

  async listLeadsReadyForNextAction(
    sequence: ReadonlyArray<EmailStage>
  ): Promise<Result<LeadRecord[]>> {
    if (sequence.length === 0) {
      return succeed([]);
    }

    try {
      const result = await this.database
        .prepare(
          'SELECT gtm_leads.id, gtm_leads.name, gtm_leads.email, gtm_leads.phone, gtm_leads.status, gtm_leads.touches_sent, ' +
            'gtm_leads.last_stage_index, gtm_leads.last_sent_at, gtm_leads.stopped_at, gtm_leads.created_at, gtm_leads.metadata, ' +
            'latest_touch.latest_touchpoint_sent_at ' +
            'FROM gtm_leads ' +
            'LEFT JOIN (' +
            '  SELECT lead_id, MAX(sent_at) AS latest_touchpoint_sent_at ' +
            '  FROM gtm_touchpoints ' +
            '  GROUP BY lead_id' +
            ') AS latest_touch ON latest_touch.lead_id = gtm_leads.id ' +
            'WHERE gtm_leads.status = ? ' +
            'ORDER BY gtm_leads.created_at ASC'
        )
        .bind(ACTIVE_STATUS)
        .all<LeadWithLatestTouchpointRow>();

      const readyLeads: LeadRecord[] = [];

      for (const row of result.results) {
        const mappedLeadResult = mapLeadRow(row);
        if (!mappedLeadResult.ok) {
          return mappedLeadResult;
        }

        const lead = mappedLeadResult.value;
        const nextStage = sequence[lead.touches_sent];

        if (!nextStage) {
          continue;
        }

        if (row.latest_touchpoint_sent_at === null) {
          readyLeads.push(lead);
          continue;
        }

        const lastTouchTimestamp = Date.parse(row.latest_touchpoint_sent_at);
        if (Number.isNaN(lastTouchTimestamp)) {
          return fail('Invalid touchpoint timestamp in durable store');
        }

        const requiredDelayMs = nextStage.delayHours * 60 * 60 * 1000;
        const elapsedMs = Date.now() - lastTouchTimestamp;

        if (elapsedMs >= requiredDelayMs) {
          readyLeads.push(lead);
        }
      }

      return succeed(readyLeads);
    } catch (error) {
      logStoreError('listLeadsReadyForNextAction', error);
      return fail('Failed to list GTM leads ready for the next action');
    }
  }

  async recordTouchpoint(touchpoint: Touchpoint): Promise<Result<void>> {
    const existingLeadResult = await this.getExistingLead(touchpoint.lead_id);
    if (!existingLeadResult.ok) {
      return existingLeadResult;
    }

    if (existingLeadResult.value === null) {
      return fail('Lead not found');
    }

    if (!isTouchpointResult(touchpoint.result)) {
      return fail('Invalid touchpoint result');
    }

    try {
      await this.database
        .prepare(
          'INSERT INTO gtm_touchpoints (id, lead_id, stage_index, sent_at, dry_run, result, message_id) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          touchpoint.id,
          touchpoint.lead_id,
          touchpoint.stage_index,
          touchpoint.sent_at,
          touchpoint.dry_run ? 1 : 0,
          touchpoint.result,
          touchpoint.message_id ?? null
        )
        .run();

      return succeed(undefined);
    } catch (error) {
      if (isUniqueConstraintError(error, 'gtm_touchpoints')) {
        return fail('Touchpoint already exists');
      }

      logStoreError('recordTouchpoint', error, {
        leadId: touchpoint.lead_id,
        touchpointId: touchpoint.id,
      });
      return fail('Failed to record GTM touchpoint');
    }
  }

  async markStopped(leadId: string, reason: LeadStatus, stoppedAt: string): Promise<Result<void>> {
    if (!isStopReason(reason)) {
      return fail('Invalid stop reason');
    }

    return this.updateLead(leadId, {
      status: reason,
      stopped_at: stoppedAt,
    });
  }

  async setSyncCursor(lastSyncedAt: string, updatedAt: string): Promise<Result<void>> {
    try {
      await this.database
        .prepare(
          'INSERT INTO gtm_sync_cursor (id, last_synced_at, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at'
        )
        .bind('gtm-reply-cursor', lastSyncedAt, updatedAt)
        .run();

      return succeed(undefined);
    } catch (error) {
      logStoreError('setSyncCursor', error, { lastSyncedAt, updatedAt });
      return fail('Failed to update GTM sync cursor');
    }
  }

  private async getExistingLead(leadId: string): Promise<Result<ExistingLeadRow | null>> {
    try {
      const row = await this.database
        .prepare('SELECT id FROM gtm_leads WHERE id = ? LIMIT 1')
        .bind(leadId)
        .first<ExistingLeadRow>();

      return succeed(row);
    } catch (error) {
      logStoreError('getExistingLead', error, { leadId });
      return fail('Failed to query GTM lead');
    }
  }

  private mapLeadRows(rows: LeadRow[]): Result<LeadRecord[]> {
    const leads: LeadRecord[] = [];

    for (const row of rows) {
      const mappedLeadResult = mapLeadRow(row);
      if (!mappedLeadResult.ok) {
        return mappedLeadResult;
      }

      leads.push(mappedLeadResult.value);
    }

    return succeed(leads);
  }

  private mapReplyRows(rows: GtmReplyRow[]): Result<GtmReply[]> {
    const replies: GtmReply[] = [];

    for (const row of rows) {
      const mappedReplyResult = mapReplyRow(row);
      if (!mappedReplyResult.ok) {
        return mappedReplyResult;
      }

      replies.push(mappedReplyResult.value);
    }

    return succeed(replies);
  }
}

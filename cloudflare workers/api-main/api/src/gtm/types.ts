/**
 * Defines the shared GTM types for the isolated outbound missed-call recovery module.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Lead {
  id: string;
  name: string;
  email: string;
  phone?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export type LeadStatus =
  | 'pending'
  | 'active'
  | 'replied'
  | 'converted'
  | 'exhausted'
  | 'opted_out'
  | 'error';

export interface LeadRecord extends Lead {
  status: LeadStatus;
  touches_sent: number;
  last_stage_index?: EmailStage['stageIndex'];
  last_sent_at?: string;
  stopped_at?: string;
}

export type TemplateKey =
  | 'missed-call-touch-1'
  | 'missed-call-touch-2'
  | 'missed-call-touch-3';

export interface EmailStage {
  stageIndex: 0 | 1 | 2;
  delayHours: number;
  templateKey: TemplateKey;
}

export type TouchpointResult = 'success' | 'error' | 'skipped';

export interface Touchpoint {
  id: string;
  lead_id: string;
  stage_index: EmailStage['stageIndex'];
  sent_at: string;
  dry_run: boolean;
  result: TouchpointResult;
  message_id?: string | null;
}

export interface ReplyClassification {
  rawText: string;
  intent: string;
  confidence: number;
  reason?: string;
}

export interface RecordReplyResult {
  classification: string;
}

export interface InboxMessage {
  id: string;
  fromEmail: string;
  subject: string | null;
  bodySnippet: string;
  receivedAt: string;
  conversationId: string | null;
  rawProviderId: string;
}

export interface InboxProvider {
  listMessages(cursor: string): Promise<Result<InboxMessage[]>>;
}

export interface SyncCursor {
  id: string;
  last_synced_at: string;
  updated_at: string;
}

export interface GtmReply {
  id: string;
  lead_id: string | null;
  from_email: string;
  subject: string | null;
  body_snippet: string;
  received_at: string;
  conversation_id: string | null;
  classification: string;
  sequence_stopped: boolean;
  raw_provider_id: string | null;
  created_at: string;
}

export interface CreateGtmReply {
  id: string;
  lead_id: string | null;
  from_email: string;
  subject: string | null;
  body_snippet: string;
  received_at: string;
  conversation_id: string | null;
  classification: string;
  sequence_stopped: boolean;
  raw_provider_id: string | null;
  created_at: string;
}

export interface UpdateGtmReply {
  lead_id?: string | null;
  classification?: string;
  sequence_stopped?: boolean;
}

export interface GtmRepliesResponse {
  synced_at: string;
  new_replies_found: number;
  replies: GtmReply[];
}

export interface GTMConfig {
  fromEmail: string;
  fromName: string;
  maxTouches: 1 | 2 | 3;
  dryRun: boolean;
}

export interface GTMBindings {
  GTM_DB: D1Database;
}

export type SequenceStopReason =
  | 'replied'
  | 'converted'
  | 'opted_out'
  | 'error'
  | 'exhausted';

export type SequenceDecision =
  | {
      action: 'send';
      stage: EmailStage;
      delayHours: number;
    }
  | {
      action: 'stop';
      reason: SequenceStopReason;
    };

export interface EmailSendResult {
  success: boolean;
  dryRun: boolean;
  messageId?: string | null;
}

export type PreparedAction =
  | {
      action: 'send';
      stage: EmailStage;
      subject: string;
      body: string;
    }
  | {
      action: 'stop';
      reason: LeadStatus;
    };

export interface AdvanceResult {
  action: 'sent' | 'stopped' | 'skipped';
  leadId: string;
  reason?: string;
}

export interface OutboundEmailMessage {
  leadId: string;
  toEmail: string;
  subject: string;
  body: string;
}

export interface PersistedLeadSequence {
  lead: Lead;
  status: LeadStatus;
  touchesSent: number;
  maxTouches: 1 | 2 | 3;
  lastStageIndex?: EmailStage['stageIndex'];
  lastScheduledAt?: string;
  lastSentAt?: string;
  replyClassification?: ReplyClassification;
  createdAt: string;
  updatedAt: string;
}

export interface RenderedEmailTemplate {
  subject: string;
  body: string;
}

export interface StartSequenceRequest {
  lead: Lead;
  config: GTMConfig;
}

export interface AdvanceSequenceRequest {
  leadId: string;
}

export interface StopSequenceRequest {
  leadId: string;
  reason: SequenceStopReason | 'manual';
}

export interface InboundReplyRequest {
  leadId: string;
  rawText: string;
}

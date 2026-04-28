/**
 * Orchestrates GTM lead state transitions without coupling this module to production webhook paths.
 */
import type {
  AdvanceResult,
  EmailSendResult,
  EmailStage,
  GTMConfig,
  GtmApprovalRecord,
  GtmRepliesResponse,
  InboxMessage,
  InboxProvider,
  Lead,
  LeadRecord,
  PreparedAction,
  RecordReplyResult,
  ReplyClassification,
  Result,
  Touchpoint,
} from './types.ts';
import type { LeadStore } from './lead-store.ts';
import type {
  LeadReviewOutput,
  OutreachWriterOutput,
  ReplyInterpreterOutput,
} from './agents/schemas.ts';

import { EmailClient } from './email-client.ts';
import { parseOutreachWriterOutput } from './agents/schemas.ts';
import { MicrosoftGraphInboxProvider } from './inbox-client.ts';
import { DurableLeadStore } from './lead-store.ts';
import { renderTemplate } from './prompts.ts';
import { ReplyClassifier } from './reply-classifier.ts';
import { SequenceEngine } from './sequence-engine.ts';

const GTM_LOG_PREFIX = '[GTM]';
const PENDING_STATUS = 'pending';
const ACTIVE_STATUS = 'active';
const REPLIED_STATUS = 'replied';
const UNKNOWN_REPLY_CLASSIFICATION = 'unknown';
const DEFAULT_SYNC_CURSOR = '1970-01-01T00:00:00.000Z';
const MAX_SYNC_BATCH_SIZE = 50;
const AGENT_TIMEOUT_MS = 12_000;
const GTM_RUNTIME_LABEL = 'production';
const COLD_OUTREACH_FORBIDDEN_PHRASES = [
  'follow up on your call',
  'follow up on your missed call',
  'calling back',
  'as discussed',
  'following up',
] as const;

export interface GtmServiceRuntimeEnv {
  GTM_DB: D1Database;
  OPENAI_API_KEY?: string;
  GTM_AGENT_MODEL?: string;
  GTM_FROM_EMAIL?: string;
  GTM_FROM_NAME?: string;
  GTM_MAX_TOUCHES?: string;
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CLIENT_SECRET?: string;
  GRAPH_MAILBOX_UPN?: string;
  SMTP_USER?: string;
}

interface GTMServiceDependencies {
  store: LeadStore;
  emailClient: EmailClient;
  sequenceEngine: SequenceEngine;
  replyClassifier: ReplyClassifier;
  config: GTMConfig;
  inboxProvider?: InboxProvider;
  agentHooks?: GTMServiceAgentHooks;
  approvalHooks?: GTMServiceApprovalHooks;
}

interface LoadedLeadContext {
  lead: LeadRecord;
  touchpoints: Touchpoint[];
}

interface ProcessedInboxMessageResult {
  isNewReply: boolean;
  ok: boolean;
  receivedAt: string;
  replyId: string;
}

export interface GTMServiceAgentHooks {
  reviewLead?: (lead: LeadRecord) => Promise<LeadReviewOutput>;
  writeOutreach?: (lead: LeadRecord, stage: EmailStage) => Promise<OutreachWriterOutput>;
  interpretReply?: (
    lead: LeadRecord | null,
    rawReply: string,
    deterministicClassification: string
  ) => Promise<ReplyInterpreterOutput>;
}

interface GTMServiceRuntimeOptions {
  agentHooks?: GTMServiceAgentHooks;
  approvalHooks?: GTMServiceApprovalHooks;
}

export interface ApprovalNotificationRequest {
  approval: GtmApprovalRecord;
  lead: LeadRecord;
  preparedAction: Extract<PreparedAction, { action: 'send' }>;
}

export interface GTMServiceApprovalHooks {
  requestApproval?: (input: ApprovalNotificationRequest) => Promise<void>;
}

function succeed<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

function logInfo(event: string, data: Record<string, unknown> = {}): void {
  console.log(GTM_LOG_PREFIX + ' ' + event, {
    ts: new Date().toISOString(),
    ...data,
  });
}

function logError(event: string, error: unknown, data: Record<string, unknown> = {}): void {
  console.error(GTM_LOG_PREFIX + ' ' + event, {
    ts: new Date().toISOString(),
    ...data,
    error: error instanceof Error ? error.message : String(error),
  });
}

function parseMaxTouches(value: string | undefined): 1 | 2 | 3 {
  switch (value?.trim()) {
    case '1':
      return 1;
    case '2':
      return 2;
    case '3':
      return 3;
    default:
      return 3;
  }
}

function buildRuntimeConfig(env: GtmServiceRuntimeEnv): GTMConfig {
  return {
    fromEmail: env.GTM_FROM_EMAIL?.trim() || env.SMTP_USER?.trim() || 'gtm-replies@example.invalid',
    fromName: env.GTM_FROM_NAME?.trim() || 'Systemix',
    maxTouches: parseMaxTouches(env.GTM_MAX_TOUCHES),
    dryRun: true,
  };
}

function subtractOneMillisecond(isoTimestamp: string): string {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    return isoTimestamp;
  }

  return new Date(Math.max(0, timestamp - 1)).toISOString();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(label + ' timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        resolve(value);
      },
      (error) => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        reject(error);
      }
    );
  });
}

function buildApprovalProposalHash(
  leadId: string,
  stageIndex: EmailStage['stageIndex'],
  subject: string,
  body: string
): string {
  const raw = `${leadId}|${stageIndex}|${subject.trim()}|${body.trim()}`;
  let hash = 2166136261;

  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `gtm-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function generateApprovalCode(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function readMetadataString(lead: LeadRecord, key: string): string | null {
  const value = lead.metadata?.[key];
  return typeof value === 'string' ? value.trim() || null : null;
}

function isWarmOrRecoveryLead(lead: LeadRecord): boolean {
  const source = readMetadataString(lead, 'source')?.toLowerCase() ?? '';
  const leadTemperature = readMetadataString(lead, 'leadTemperature')?.toLowerCase() ?? '';
  const gtmLeadTemperature = readMetadataString(lead, 'gtmLeadTemperature')?.toLowerCase() ?? '';

  return (
    source.includes('recovery') ||
    source.includes('missed-call') ||
    leadTemperature === 'warm' ||
    leadTemperature === 'recovery' ||
    gtmLeadTemperature === 'warm' ||
    gtmLeadTemperature === 'recovery'
  );
}

function findColdOutreachForbiddenPhrase(subject: string, body: string): string | null {
  const normalized = `${subject}\n${body}`.toLowerCase();
  return COLD_OUTREACH_FORBIDDEN_PHRASES.find((phrase) => normalized.includes(phrase)) ?? null;
}

function assertColdOutreachCopySafe(
  lead: LeadRecord,
  subject: string,
  body: string,
  stageIndex?: EmailStage['stageIndex']
): void {
  if (isWarmOrRecoveryLead(lead)) {
    return;
  }

  const forbiddenPhrase = findColdOutreachForbiddenPhrase(subject, body);
  if (forbiddenPhrase) {
    logInfo('gtm_cold_copy_safety_rejected', {
      system: 'gtm',
      leadId: lead.id,
      stageIndex: stageIndex ?? null,
      forbiddenPhrase,
      fallbackUsed: true,
    });
    throw new Error(`Cold GTM outreach cannot imply prior contact: ${forbiddenPhrase}`);
  }
}

export function createRuntimeGtmService(
  env: GtmServiceRuntimeEnv,
  options: GTMServiceRuntimeOptions = {}
): GTMService {
  const config = buildRuntimeConfig(env);

  return new GTMService({
    store: new DurableLeadStore(env.GTM_DB),
    emailClient: new EmailClient(config),
    sequenceEngine: new SequenceEngine({ maxTouches: config.maxTouches }),
    replyClassifier: new ReplyClassifier(),
    config,
    inboxProvider: new MicrosoftGraphInboxProvider(env),
    agentHooks: options.agentHooks,
    approvalHooks: options.approvalHooks,
  });
}

export class GTMService {
  private readonly store: LeadStore;
  private readonly emailClient: EmailClient;
  private readonly sequenceEngine: SequenceEngine;
  private readonly replyClassifier: ReplyClassifier;
  private readonly config: GTMConfig;
  private readonly inboxProvider: InboxProvider | null;
  private readonly agentHooks: GTMServiceAgentHooks | null;
  private readonly approvalHooks: GTMServiceApprovalHooks | null;

  constructor(dependencies: GTMServiceDependencies) {
    this.store = dependencies.store;
    this.emailClient = dependencies.emailClient;
    this.sequenceEngine = dependencies.sequenceEngine;
    this.replyClassifier = dependencies.replyClassifier;
    this.config = {
      ...dependencies.config,
      dryRun: dependencies.config.dryRun !== false,
    };
    this.inboxProvider = dependencies.inboxProvider ?? null;
    this.agentHooks = dependencies.agentHooks ?? null;
    this.approvalHooks = dependencies.approvalHooks ?? null;
  }

  async createLead(lead: Lead): Promise<Result<void>> {
    const existingLeadResult = await this.store.getLeadById(lead.id);
    if (!existingLeadResult.ok) {
      return fail(existingLeadResult.error);
    }

    if (existingLeadResult.value !== null) {
      if (existingLeadResult.value.status !== PENDING_STATUS) {
        return fail('Lead already exists with status ' + existingLeadResult.value.status);
      }

      return fail('Lead already exists');
    }

    const createLeadResult = await this.store.createLead(lead);
    if (!createLeadResult.ok) {
      return fail(createLeadResult.error);
    }

    logInfo('gtm_lead_created', {
      leadId: lead.id,
      status: PENDING_STATUS,
    });

    return succeed(undefined);
  }

  async startSequence(leadId: string): Promise<Result<void>> {
    const leadResult = await this.store.getLeadById(leadId);
    if (!leadResult.ok) {
      return fail(leadResult.error);
    }

    if (leadResult.value === null) {
      return fail('Lead not found');
    }

    if (leadResult.value.status !== PENDING_STATUS) {
      return fail('Lead must be pending to start the sequence');
    }

    if (this.agentHooks?.reviewLead) {
      try {
        const review = await withTimeout(
          this.agentHooks.reviewLead(leadResult.value),
          AGENT_TIMEOUT_MS,
          'lead review agent'
        );

        if (review.decision === 'reject') {
          logInfo('gtm_lead_review_rejected', {
            leadId,
            score: review.score,
            outreachAngle: review.outreachAngle,
            reasoning: review.reasoning,
            riskFlags: review.riskFlags,
          });

          return fail('Lead review rejected activation: ' + review.reasoning);
        }
      } catch (error) {
        logError('gtm_lead_review_failed_open', error, {
          leadId,
          fallback: 'start_sequence_without_agent_gate',
        });
      }
    }

    const updateLeadResult = await this.store.updateLead(leadId, {
      status: ACTIVE_STATUS,
    });
    if (!updateLeadResult.ok) {
      return fail(updateLeadResult.error);
    }

    logInfo('gtm_sequence_started', {
      leadId,
      fromStatus: leadResult.value.status,
      toStatus: ACTIVE_STATUS,
    });

    return succeed(undefined);
  }

  async prepareNextAction(leadId: string): Promise<Result<PreparedAction>> {
    const leadContextResult = await this.loadLeadContext(leadId);
    if (!leadContextResult.ok) {
      return fail(leadContextResult.error);
    }

    const { lead, touchpoints } = leadContextResult.value;

    if (touchpoints.length !== lead.touches_sent) {
      logInfo('gtm_touchpoint_history_mismatch', {
        leadId,
        touchesSent: lead.touches_sent,
        touchpointCount: touchpoints.length,
      });
    }

    const decision = this.sequenceEngine.next(lead.touches_sent, lead.status);
    if (decision.action === 'stop') {
      return succeed({
        action: 'stop',
        reason: decision.reason,
      });
    }

    try {
      let subject: string;
      let body: string;

      if (this.agentHooks?.writeOutreach) {
        try {
          const rawAgentDraft = await withTimeout(
            this.agentHooks.writeOutreach(lead, decision.stage),
            AGENT_TIMEOUT_MS,
            'outreach writer agent'
          );
          const agentDraft = parseOutreachWriterOutput(rawAgentDraft);
          assertColdOutreachCopySafe(lead, agentDraft.subject, agentDraft.body, decision.stage.stageIndex);

          subject = agentDraft.subject;
          body = agentDraft.body;
          logInfo('gtm_outreach_writer_completed', {
            system: 'gtm',
            agent: 'outreach_writer',
            leadId,
            stageIndex: decision.stage.stageIndex,
            schemaValidation: 'passed',
            fallbackUsed: false,
            runtime: GTM_RUNTIME_LABEL,
            variantLabel: agentDraft.variantLabel,
          });
        } catch (error) {
          logError('gtm_outreach_writer_fallback', error, {
            system: 'gtm',
            agent: 'outreach_writer',
            leadId,
            stageIndex: decision.stage.stageIndex,
            schemaValidation: 'failed',
            fallbackUsed: true,
            runtime: GTM_RUNTIME_LABEL,
            templateKey: decision.stage.templateKey,
            fallback: 'render_template',
          });

          const rendered = renderTemplate(decision.stage.templateKey, lead);
          assertColdOutreachCopySafe(lead, rendered.subject, rendered.body, decision.stage.stageIndex);
          subject = rendered.subject;
          body = rendered.body;
        }
      } else {
        const rendered = renderTemplate(decision.stage.templateKey, lead);
        assertColdOutreachCopySafe(lead, rendered.subject, rendered.body, decision.stage.stageIndex);
        subject = rendered.subject;
        body = rendered.body;
      }

      return succeed({
        action: 'send',
        stage: decision.stage,
        subject,
        body,
      });
    } catch (error) {
      logError('gtm_prepare_next_action_render_failed', error, {
        leadId,
        templateKey: decision.stage.templateKey,
      });
      return fail('Failed to render GTM email template');
    }
  }

  async advanceLeadSequence(leadId: string): Promise<Result<AdvanceResult>> {
    const preparedActionResult = await this.prepareNextAction(leadId);
    if (!preparedActionResult.ok) {
      return fail(preparedActionResult.error);
    }

    const leadResult = await this.store.getLeadById(leadId);
    if (!leadResult.ok) {
      return fail(leadResult.error);
    }

    if (leadResult.value === null) {
      return fail('Lead not found');
    }

    const lead = leadResult.value;
    const preparedAction = preparedActionResult.value;

    if (preparedAction.action === 'stop') {
      const stoppedAt = new Date().toISOString();
      const stopResult = await this.store.markStopped(leadId, preparedAction.reason, stoppedAt);
      if (!stopResult.ok) {
        return fail(stopResult.error);
      }

      logInfo('gtm_sequence_stopped', {
        leadId,
        fromStatus: lead.status,
        toStatus: preparedAction.reason,
        stoppedAt,
      });

      return succeed({
        action: 'stopped',
        leadId,
        reason: preparedAction.reason,
      });
    }

    if (lead.status !== ACTIVE_STATUS) {
      return fail('Lead must be active before advancing the sequence');
    }

    if (!this.config.dryRun) {
      return fail('Live GTM email sending is not implemented');
    }

    const approvalResult = await this.requireOutboundApproval(lead, preparedAction);
    if (!approvalResult.ok) {
      return fail(approvalResult.error);
    }

    if (approvalResult.value.approved !== true) {
      return succeed({
        action: 'skipped',
        leadId,
        reason: approvalResult.value.reason,
      });
    }

    const sentAt = new Date().toISOString();
    const touchpoint: Touchpoint = {
      id: crypto.randomUUID(),
      lead_id: leadId,
      stage_index: preparedAction.stage.stageIndex,
      sent_at: sentAt,
      dry_run: this.config.dryRun,
      result: 'skipped',
      message_id: null,
    };

    const recordTouchpointResult = await this.store.recordTouchpoint(touchpoint);
    if (!recordTouchpointResult.ok) {
      return fail(recordTouchpointResult.error);
    }

    logInfo('gtm_touchpoint_persisted', {
      leadId,
      touchpointId: touchpoint.id,
      stageIndex: touchpoint.stage_index,
      dryRun: touchpoint.dry_run,
      result: touchpoint.result,
      sentAt: touchpoint.sent_at,
    });

    let sendResult: EmailSendResult;
    try {
      sendResult = await this.emailClient.send({
        leadId,
        toEmail: lead.email,
        subject: preparedAction.subject,
        body: preparedAction.body,
      });
    } catch (error) {
      logError('gtm_email_send_failed', error, {
        leadId,
        stageIndex: preparedAction.stage.stageIndex,
        dryRun: this.config.dryRun,
      });
      return fail('Failed to send GTM email');
    }

    if (!sendResult.success) {
      const sendError = new Error('Email client returned success=false');
      logError('gtm_email_send_unsuccessful', sendError, {
        leadId,
        stageIndex: preparedAction.stage.stageIndex,
        dryRun: sendResult.dryRun,
      });
      return fail('Failed to send GTM email');
    }

    const approvedProposal = approvalResult.value.approval;
    if (approvedProposal !== null) {
      const markExecutedResult = await this.store.markApprovalExecuted(approvedProposal.id, sentAt);
      if (!markExecutedResult.ok) {
        logError('gtm_approval_mark_executed_failed', new Error(markExecutedResult.error), {
          leadId,
          approvalId: approvedProposal.id,
          approvalCode: approvedProposal.approval_code,
        });
      }
    }

    const updateLeadResult = await this.store.updateLead(leadId, {
      touches_sent: lead.touches_sent + 1,
      last_stage_index: preparedAction.stage.stageIndex,
      last_sent_at: sentAt,
    });
    if (!updateLeadResult.ok) {
      logError('gtm_lead_state_update_failed', new Error(updateLeadResult.error), {
        leadId,
        stageIndex: preparedAction.stage.stageIndex,
        touchesSent: lead.touches_sent + 1,
        lastSentAt: sentAt,
      });
      return fail(updateLeadResult.error);
    }

    const action = sendResult.dryRun ? 'skipped' : 'sent';

    logInfo('gtm_lead_advanced', {
      leadId,
      action,
      stageIndex: preparedAction.stage.stageIndex,
      touchesSent: lead.touches_sent + 1,
      lastSentAt: sentAt,
      dryRun: sendResult.dryRun,
      messageId: sendResult.messageId ?? null,
    });

    return succeed({
      action,
      leadId,
      reason: sendResult.dryRun ? 'dry_run' : undefined,
    });
  }

  async recordReply(leadId: string, rawReply: string): Promise<Result<RecordReplyResult>> {
    let classification: ReplyClassification | null = null;

    try {
      classification = this.replyClassifier.classify(rawReply);
      logInfo('gtm_reply_classified', {
        leadId,
        intent: classification.intent,
        confidence: classification.confidence,
        reason: classification.reason ?? null,
      });
    } catch (error) {
      logError('gtm_reply_classification_failed', error, {
        leadId,
      });
    }

    const stoppedAt = new Date().toISOString();
    const stopResult = await this.store.markStopped(leadId, REPLIED_STATUS, stoppedAt);
    if (!stopResult.ok) {
      return fail(stopResult.error);
    }

    logInfo('gtm_sequence_stopped_by_reply', {
      leadId,
      stoppedAt,
      intent: classification?.intent ?? null,
    });

    if (this.agentHooks?.interpretReply) {
      try {
        const leadResult = await this.store.getLeadById(leadId);
        const leadForInterpretation = leadResult.ok ? leadResult.value : null;
        const advisory = await withTimeout(
          this.agentHooks.interpretReply(
            leadForInterpretation,
            rawReply,
            classification?.intent ?? UNKNOWN_REPLY_CLASSIFICATION
          ),
          AGENT_TIMEOUT_MS,
          'reply interpreter agent'
        );

        logInfo('gtm_reply_interpreter_advisory', {
          leadId,
          classification: advisory.classification,
          confidence: advisory.confidence,
          recommendedManualAction: advisory.recommendedManualAction,
          urgent: advisory.urgent,
          reasoning: advisory.reasoning,
        });
      } catch (error) {
        logError('gtm_reply_interpreter_failed_open', error, {
          leadId,
          fallback: 'deterministic_reply_stop_only',
        });
      }
    }

    return succeed({
      classification: classification?.intent ?? UNKNOWN_REPLY_CLASSIFICATION,
    });
  }

  async syncAndListReplies(limit: number, matchedOnly: boolean): Promise<Result<GtmRepliesResponse>> {
    const syncResult = await this.syncRepliesFromInbox();
    if (!syncResult.ok) {
      return fail(syncResult.error);
    }

    const repliesResult = await this.store.listReplies(limit, matchedOnly);
    if (!repliesResult.ok) {
      return fail(repliesResult.error);
    }

    return succeed({
      synced_at: syncResult.value.synced_at,
      new_replies_found: syncResult.value.new_replies_found,
      replies: repliesResult.value,
    });
  }

  async listRepliesForLead(leadId: string): Promise<Result<GtmRepliesResponse>> {
    const leadResult = await this.store.getLeadById(leadId);
    if (!leadResult.ok) {
      return fail(leadResult.error);
    }

    if (leadResult.value === null) {
      return fail('Lead not found');
    }

    const syncedAtResult = await this.getLastSyncedAt();
    if (!syncedAtResult.ok) {
      return fail(syncedAtResult.error);
    }

    const repliesResult = await this.store.listRepliesByLeadId(leadId);
    if (!repliesResult.ok) {
      return fail(repliesResult.error);
    }

    return succeed({
      synced_at: syncedAtResult.value,
      new_replies_found: 0,
      replies: repliesResult.value,
    });
  }

  async getLeadsReadyForNextAction(): Promise<Result<LeadRecord[]>> {
    return this.store.listLeadsReadyForNextAction(this.sequenceEngine.getSequence());
  }

  private async requireOutboundApproval(
    lead: LeadRecord,
    preparedAction: Extract<PreparedAction, { action: 'send' }>
  ): Promise<Result<{ approved: true; approval: GtmApprovalRecord | null } | { approved: false; approval: null; reason: string }>> {
    const proposalHash = buildApprovalProposalHash(
      lead.id,
      preparedAction.stage.stageIndex,
      preparedAction.subject,
      preparedAction.body
    );

    const existingApprovalResult = await this.store.getLatestApprovalByProposal(
      lead.id,
      preparedAction.stage.stageIndex,
      proposalHash
    );
    if (!existingApprovalResult.ok) {
      return fail(existingApprovalResult.error);
    }

    const existingApproval = existingApprovalResult.value;
    if (existingApproval?.status === 'approved') {
      logInfo('gtm_approval_reused', {
        system: 'gtm',
        leadId: lead.id,
        approvalId: existingApproval.id,
        approvalCode: existingApproval.approval_code,
        approvalStatus: existingApproval.status,
        stageIndex: existingApproval.stage_index,
        proposalHash,
        deduped: true,
        smsPreview: null,
      });
      return succeed({
        approved: true,
        approval: existingApproval,
      });
    }

    if (existingApproval?.status === 'executed') {
      logInfo('gtm_approval_already_executed', {
        leadId: lead.id,
        approvalId: existingApproval.id,
        approvalCode: existingApproval.approval_code,
        approvalStatus: existingApproval.status,
        stageIndex: existingApproval.stage_index,
        proposalHash,
        deduped: true,
        smsPreview: null,
      });

      return fail('Approval already executed for this proposal; GTM lead state requires manual repair');
    }

    if (existingApproval?.status === 'rejected') {
      logInfo('gtm_approval_rejected', {
        leadId: lead.id,
        approvalId: existingApproval.id,
        approvalCode: existingApproval.approval_code,
        approvalStatus: existingApproval.status,
        stageIndex: existingApproval.stage_index,
        proposalHash,
        deduped: true,
        smsPreview: null,
      });

      return succeed({
        approved: false,
        approval: null,
        reason: 'approval_rejected',
      });
    }

    let approval = existingApproval;
    let createdApproval = false;
    if (approval === null) {
      const requestedAt = new Date().toISOString();
      approval = {
        id: crypto.randomUUID(),
        approval_code: generateApprovalCode(),
        lead_id: lead.id,
        stage_index: preparedAction.stage.stageIndex,
        proposal_hash: proposalHash,
        subject: preparedAction.subject,
        body: preparedAction.body,
        status: 'pending',
        requested_at: requestedAt,
      };

      const createApprovalResult = await this.store.createApproval(approval);
      if (!createApprovalResult.ok) {
        if (createApprovalResult.error === 'Approval already exists') {
          const latestApprovalResult = await this.store.getLatestApprovalByProposal(
            lead.id,
            preparedAction.stage.stageIndex,
            proposalHash
          );
          if (!latestApprovalResult.ok) {
            return fail(latestApprovalResult.error);
          }

          approval = latestApprovalResult.value;
          if (approval === null) {
            return fail('Failed to load GTM approval after duplicate approval detection');
          }

          logInfo('gtm_approval_deduped_reused', {
            system: 'gtm',
            leadId: lead.id,
            approvalId: approval.id,
            approvalCode: approval.approval_code,
            approvalStatus: approval.status,
            stageIndex: approval.stage_index,
            proposalHash,
            deduped: true,
            smsPreview: null,
          });
        } else {
          return fail(createApprovalResult.error);
        }
      } else {
        createdApproval = true;
        logInfo('gtm_approval_requested', {
          system: 'gtm',
          leadId: lead.id,
          approvalId: approval.id,
          approvalCode: approval.approval_code,
          approvalStatus: approval.status,
          stageIndex: approval.stage_index,
          proposalHash,
          deduped: false,
          smsPreview: preparedAction.body,
        });
      }
    } else {
      logInfo('gtm_approval_pending_reused', {
        system: 'gtm',
        leadId: lead.id,
        approvalId: approval.id,
        approvalCode: approval.approval_code,
        approvalStatus: approval.status,
        stageIndex: approval.stage_index,
        proposalHash,
        deduped: true,
        smsPreview: approval.body,
      });
    }

    if (createdApproval) {
      await this.notifyApprovalRequested(lead, preparedAction, approval, proposalHash);
    }

    return succeed({
      approved: false,
      approval: null,
      reason: 'awaiting_approval',
    });
  }

  private async notifyApprovalRequested(
    lead: LeadRecord,
    preparedAction: Extract<PreparedAction, { action: 'send' }>,
    approval: GtmApprovalRecord,
    proposalHash: string
  ): Promise<void> {
    if (approval.notified_at) {
      logInfo('gtm_approval_notification_reused', {
        system: 'gtm',
        leadId: lead.id,
        approvalId: approval.id,
        approvalCode: approval.approval_code,
        approvalStatus: approval.status,
        stageIndex: approval.stage_index,
        proposalHash,
        deduped: true,
        smsPreview: approval.body,
      });
      return;
    }

    if (!this.approvalHooks?.requestApproval) {
      logInfo('gtm_approval_notification_not_configured', {
        leadId: lead.id,
        approvalId: approval.id,
        approvalCode: approval.approval_code,
        approvalStatus: approval.status,
        stageIndex: approval.stage_index,
        proposalHash,
        deduped: false,
        smsPreview: preparedAction.body,
      });
      return;
    }

    try {
      await withTimeout(
        this.approvalHooks.requestApproval({
          approval,
          lead,
          preparedAction,
        }),
        AGENT_TIMEOUT_MS,
        'approval notification hook'
      );

      const notifiedAt = new Date().toISOString();
      const markNotifiedResult = await this.store.markApprovalNotified(approval.id, notifiedAt);
      if (!markNotifiedResult.ok) {
        logError('gtm_approval_mark_notified_failed', new Error(markNotifiedResult.error), {
          leadId: lead.id,
          approvalId: approval.id,
          approvalCode: approval.approval_code,
          approvalStatus: approval.status,
          stageIndex: approval.stage_index,
          proposalHash,
          deduped: false,
          smsPreview: preparedAction.body,
        });
        return;
      }

      approval.notified_at = notifiedAt;
    } catch (error) {
      logError('gtm_approval_notification_failed', error, {
        leadId: lead.id,
        approvalId: approval.id,
        approvalCode: approval.approval_code,
        approvalStatus: approval.status,
        stageIndex: approval.stage_index,
        proposalHash,
        deduped: false,
        smsPreview: preparedAction.body,
        fallback: 'pending_approval_without_sms_notification',
      });
    }
  }

  private async loadLeadContext(leadId: string): Promise<Result<LoadedLeadContext>> {
    const leadResult = await this.store.getLeadById(leadId);
    if (!leadResult.ok) {
      return fail(leadResult.error);
    }

    if (leadResult.value === null) {
      return fail('Lead not found');
    }

    const touchpointsResult = await this.store.listTouchpointsByLeadId(leadId);
    if (!touchpointsResult.ok) {
      return fail(touchpointsResult.error);
    }

    return succeed({
      lead: leadResult.value,
      touchpoints: touchpointsResult.value,
    });
  }

  private async getLastSyncedAt(): Promise<Result<string>> {
    const cursorResult = await this.store.getSyncCursor();
    if (!cursorResult.ok) {
      return fail(cursorResult.error);
    }

    return succeed(cursorResult.value?.last_synced_at ?? DEFAULT_SYNC_CURSOR);
  }

  private async matchReplyToLead(message: InboxMessage): Promise<Result<LeadRecord | null>> {
    if (message.fromEmail.trim().length === 0) {
      return fail('Reply is missing from_email');
    }

    const emailMatchResult = await this.store.findLeadByEmail(message.fromEmail);
    if (!emailMatchResult.ok) {
      return fail(emailMatchResult.error);
    }

    if (emailMatchResult.value !== null) {
      return succeed(emailMatchResult.value);
    }

    // Conversation-id matching stays disabled until outbound GTM records persist it reliably.
    return succeed(null);
  }

  private async processInboxMessage(message: InboxMessage): Promise<ProcessedInboxMessageResult> {
    if (message.fromEmail.trim().length === 0) {
      logError('gtm_reply_missing_from_email', new Error('Missing from email'), {
        replyId: message.id,
        conversationId: message.conversationId,
      });

      return {
        isNewReply: false,
        ok: false,
        receivedAt: message.receivedAt,
        replyId: message.id,
      };
    }

    const createdAt = new Date().toISOString();
    const createReplyResult = await this.store.createReply({
      id: message.id,
      lead_id: null,
      from_email: message.fromEmail,
      subject: message.subject,
      body_snippet: message.bodySnippet,
      received_at: message.receivedAt,
      conversation_id: message.conversationId,
      classification: UNKNOWN_REPLY_CLASSIFICATION,
      sequence_stopped: false,
      raw_provider_id: message.rawProviderId,
      created_at: createdAt,
    });

    if (!createReplyResult.ok) {
      logError('gtm_reply_store_failed', new Error(createReplyResult.error), {
        replyId: message.id,
        fromEmail: message.fromEmail,
      });

      return {
        isNewReply: false,
        ok: false,
        receivedAt: message.receivedAt,
        replyId: message.id,
      };
    }

    const matchedLeadResult = await this.matchReplyToLead(message);
    if (!matchedLeadResult.ok) {
      logError('gtm_reply_match_failed', new Error(matchedLeadResult.error), {
        replyId: message.id,
        fromEmail: message.fromEmail,
      });

      return {
        isNewReply: createReplyResult.value === 'created',
        ok: false,
        receivedAt: message.receivedAt,
        replyId: message.id,
      };
    }

    if (matchedLeadResult.value === null) {
      logInfo('gtm_reply_unmatched', {
        replyId: message.id,
        fromEmail: message.fromEmail,
        conversationId: message.conversationId,
      });

      return {
        isNewReply: createReplyResult.value === 'created',
        ok: true,
        receivedAt: message.receivedAt,
        replyId: message.id,
      };
    }

    const updateMatchedReplyResult = await this.store.updateReply(message.id, {
      lead_id: matchedLeadResult.value.id,
    });
    if (!updateMatchedReplyResult.ok) {
      logError('gtm_reply_match_persist_failed', new Error(updateMatchedReplyResult.error), {
        replyId: message.id,
        leadId: matchedLeadResult.value.id,
      });

      return {
        isNewReply: createReplyResult.value === 'created',
        ok: false,
        receivedAt: message.receivedAt,
        replyId: message.id,
      };
    }

    const recordReplyResult = await this.recordReply(matchedLeadResult.value.id, message.bodySnippet);
    if (!recordReplyResult.ok) {
      logError('gtm_reply_stop_failed', new Error(recordReplyResult.error), {
        replyId: message.id,
        leadId: matchedLeadResult.value.id,
      });

      return {
        isNewReply: createReplyResult.value === 'created',
        ok: false,
        receivedAt: message.receivedAt,
        replyId: message.id,
      };
    }

    const updateStoppedReplyResult = await this.store.updateReply(message.id, {
      classification: recordReplyResult.value.classification,
      lead_id: matchedLeadResult.value.id,
      sequence_stopped: true,
    });
    if (!updateStoppedReplyResult.ok) {
      logError('gtm_reply_stop_persist_failed', new Error(updateStoppedReplyResult.error), {
        replyId: message.id,
        leadId: matchedLeadResult.value.id,
      });

      return {
        isNewReply: createReplyResult.value === 'created',
        ok: false,
        receivedAt: message.receivedAt,
        replyId: message.id,
      };
    }

    logInfo('gtm_reply_matched', {
      replyId: message.id,
      leadId: matchedLeadResult.value.id,
      classification: recordReplyResult.value.classification,
    });

    return {
      isNewReply: createReplyResult.value === 'created',
      ok: true,
      receivedAt: message.receivedAt,
      replyId: message.id,
    };
  }

  private resolveNextSyncCursor(
    messages: InboxMessage[],
    processingResults: ReadonlyArray<ProcessedInboxMessageResult>
  ): string {
    if (messages.length === 0) {
      return new Date().toISOString();
    }

    const firstFailedResult = processingResults.find((result) => !result.ok);
    if (firstFailedResult !== undefined) {
      return subtractOneMillisecond(firstFailedResult.receivedAt);
    }

    const lastReceivedAt = messages[messages.length - 1].receivedAt;
    if (messages.length >= MAX_SYNC_BATCH_SIZE) {
      return subtractOneMillisecond(lastReceivedAt);
    }

    return lastReceivedAt;
  }

  private async syncRepliesFromInbox(): Promise<
    Result<{ synced_at: string; new_replies_found: number }>
  > {
    if (this.inboxProvider === null) {
      return fail('Inbox provider is not configured');
    }

    const cursorResult = await this.store.getSyncCursor();
    if (!cursorResult.ok) {
      return fail(cursorResult.error);
    }

    const currentCursor = cursorResult.value?.last_synced_at ?? DEFAULT_SYNC_CURSOR;
    const inboxMessagesResult = await this.inboxProvider.listMessages(currentCursor);
    if (!inboxMessagesResult.ok) {
      return fail(inboxMessagesResult.error);
    }

    const messages = [...inboxMessagesResult.value].sort((left, right) =>
      left.receivedAt.localeCompare(right.receivedAt)
    );
    const processingResults = await Promise.all(
      messages.map(async (message) => this.processInboxMessage(message))
    );

    const nextCursor = this.resolveNextSyncCursor(messages, processingResults);
    const updatedAt = new Date().toISOString();
    const setCursorResult = await this.store.setSyncCursor(nextCursor, updatedAt);
    if (!setCursorResult.ok) {
      return fail(setCursorResult.error);
    }

    return succeed({
      synced_at: nextCursor,
      new_replies_found: processingResults.filter((result) => result.isNewReply).length,
    });
  }
}

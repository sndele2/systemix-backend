/**
 * Exposes the isolated GTM module surface so callers import only from this file.
 */
export { EmailClient } from './email-client.ts';
export { createGtmHandler, createGtmInternalFlowHandler, createGtmInternalRepliesHandler } from './handler.ts';
export { MicrosoftGraphInboxProvider } from './inbox-client.ts';
export { DurableLeadStore } from './lead-store.ts';
export { renderTemplate } from './prompts.ts';
export { ReplyClassifier } from './reply-classifier.ts';
export { DEFAULT_SEQUENCE, SequenceEngine } from './sequence-engine.ts';
export { createRuntimeGtmService, GTMService } from './service.ts';

export type { LeadStore } from './lead-store.ts';
export type {
  AdvanceResult,
  AdvanceSequenceRequest,
  CreateGtmReply,
  EmailSendResult,
  EmailStage,
  GTMConfig,
  GTMBindings,
  GtmRepliesResponse,
  GtmReply,
  InboxMessage,
  InboxProvider,
  InboundReplyRequest,
  Lead,
  LeadStatus,
  OutboundEmailMessage,
  PersistedLeadSequence,
  PreparedAction,
  RecordReplyResult,
  RenderedEmailTemplate,
  ReplyClassification,
  SequenceDecision,
  SequenceStopReason,
  StartSequenceRequest,
  SyncCursor,
  StopSequenceRequest,
  TemplateKey,
  UpdateGtmReply,
} from './types.ts';

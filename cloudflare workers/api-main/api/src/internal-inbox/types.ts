export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type InboxConversationSource = 'missed_call' | 'voicemail' | 'sms';

export type InboxConversationEventType = 'system' | 'customer' | 'operator';

export interface InboxConversationContact {
  phoneNumber: string;
}

export interface InboxConversationSummary {
  id: string;
  businessNumber: string;
  contact: InboxConversationContact;
  source: InboxConversationSource;
  preview: string;
  updatedAt: string;
  status?: string;
}

export interface InboxConversationMessage {
  id: string;
  type: InboxConversationEventType;
  source: InboxConversationSource;
  body: string;
  timestamp: string;
  rawProviderId: string | null;
}

export interface InboxConversation {
  id: string;
  businessNumber: string;
  contact: InboxConversationContact;
  source: InboxConversationSource;
  updatedAt: string;
  status?: string;
  messages: InboxConversationMessage[];
}

export interface InternalInboxProvider {
  listConversations(
    businessNumber: string,
    limit: number
  ): Promise<Result<InboxConversationSummary[]>>;
  getConversation(
    businessNumber: string,
    conversationId: string
  ): Promise<Result<InboxConversation | null>>;
  replyToConversation(
    businessNumber: string,
    conversationId: string,
    body: string
  ): Promise<Result<void>>;
}

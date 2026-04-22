import { z } from 'zod'

const trimmedString = z.string().trim().min(1)
const optionalTrimmedString = trimmedString.optional()

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return value
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function countWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function containsMarkdown(value: string): boolean {
  const markdownPattern = /(^|\s)([#*_`>~]|\[[^\]]+\]\([^)]+\))/m
  const bulletPattern = /^\s*([-*]|\d+\.)\s+/m
  return markdownPattern.test(value) || bulletPattern.test(value)
}

function assertPlainTextBody(body: string): void {
  if (containsMarkdown(body)) {
    throw new Error('Outreach writer output must be plain text without markdown or bullets')
  }
}

function assertBodyWordLimit(body: string, maxWords = 70): void {
  const wordCount = countWords(body)
  if (wordCount > maxWords) {
    throw new Error(`Outreach writer output exceeded the ${maxWords}-word limit`)
  }
}

export const GtmAgentTaskSchema = z.enum([
  'lead_discovery',
  'lead_review',
  'outreach_writer',
  'reply_interpreter',
])

export const GtmAgentToolScopeSchema = z.enum([
  'shared',
  'lead_discovery',
  'lead_review',
  'outreach_writer',
  'reply_interpreter',
])

export const CandidateBusinessSchema = z
  .object({
    businessName: trimmedString.max(160),
    contactName: optionalTrimmedString,
    website: z.string().trim().url().optional(),
    email: z.string().trim().email().optional(),
    phone: optionalTrimmedString,
    city: optionalTrimmedString,
    state: optionalTrimmedString,
    industry: optionalTrimmedString,
    source: optionalTrimmedString,
    summary: z.string().trim().max(280).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const LeadDiscoveryInputSchema = z
  .object({
    objective: trimmedString.max(280),
    searchHints: z.array(trimmedString.max(120)).max(10).default([]),
    seedBusinesses: z.array(CandidateBusinessSchema.partial()).max(25).default([]),
    marketNotes: z.string().trim().max(600).optional(),
    maxCandidates: z.number().int().min(1).max(25).default(10),
  })
  .strict()

export const LeadDiscoveryOutputSchema = z
  .object({
    candidates: z.array(CandidateBusinessSchema).max(25),
    limitations: z.array(trimmedString.max(180)).max(10).default([]),
  })
  .strict()

export const OutreachAngleSchema = z.enum([
  'missed_call_recovery',
  'lost_jobs_recovery',
  'revenue_recovery',
  'general_follow_up',
  'no_fit',
])

export const LeadReviewInputSchema = z
  .object({
    candidate: CandidateBusinessSchema,
    qualificationCriteria: z.array(trimmedString.max(180)).max(10).default([]),
    evaluationContext: z.string().trim().max(600).optional(),
  })
  .strict()

export const LeadReviewOutputSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    score: z.number().int().min(0).max(100),
    outreachAngle: OutreachAngleSchema,
    reasoning: trimmedString.max(320),
    riskFlags: z.array(trimmedString.max(140)).max(10).default([]),
  })
  .strict()

export const OutreachWriterInputSchema = z
  .object({
    candidate: CandidateBusinessSchema,
    outreachAngle: OutreachAngleSchema,
    businessContext: z.string().trim().max(600).optional(),
    groundingFacts: z.array(trimmedString.max(180)).max(10).default([]),
    maxWords: z.number().int().min(20).max(120).default(70),
  })
  .strict()

export const OutreachWriterOutputSchema = z
  .object({
    subject: trimmedString.max(120),
    body: trimmedString.max(700),
    variantLabel: trimmedString.max(80),
  })
  .strict()

export const ReplyInterpreterInputSchema = z
  .object({
    replyText: trimmedString.max(4000),
    leadContext: CandidateBusinessSchema.optional(),
    recentOutreach: z
      .object({
        subject: optionalTrimmedString,
        body: optionalTrimmedString,
      })
      .strict()
      .optional(),
    conversationNotes: z.string().trim().max(600).optional(),
  })
  .strict()

export const ReplyClassificationSchema = z.enum([
  'interested',
  'not_interested',
  'stop',
  'wrong_contact',
  'already_handled',
  'pricing_question',
  'neutral',
  'spam',
  'unknown',
])

export const ReplyManualActionSchema = z.enum([
  'call_now',
  'manual_follow_up',
  'mark_do_not_contact',
  'verify_contact',
  'close_out',
  'review_manually',
])

export const ReplyInterpreterOutputSchema = z
  .object({
    classification: ReplyClassificationSchema,
    confidence: z.number().min(0).max(1),
    reasoning: trimmedString.max(320),
    recommendedManualAction: ReplyManualActionSchema,
    urgent: z.boolean(),
  })
  .strict()

export const RuntimeToolStubOutputSchema = z
  .object({
    status: z.literal('todo'),
    toolName: trimmedString.max(120),
    note: trimmedString.max(240),
    receivedInput: z.unknown().optional(),
  })
  .strict()

export const ManagerInputSchema = z
  .object({
    task: GtmAgentTaskSchema,
    leadDiscoveryInput: LeadDiscoveryInputSchema.optional(),
    leadReviewInput: LeadReviewInputSchema.optional(),
    outreachWriterInput: OutreachWriterInputSchema.optional(),
    replyInterpreterInput: ReplyInterpreterInputSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedKeyByTask = {
      lead_discovery: 'leadDiscoveryInput',
      lead_review: 'leadReviewInput',
      outreach_writer: 'outreachWriterInput',
      reply_interpreter: 'replyInterpreterInput',
    } as const

    const providedKeys = Object.entries({
      leadDiscoveryInput: value.leadDiscoveryInput,
      leadReviewInput: value.leadReviewInput,
      outreachWriterInput: value.outreachWriterInput,
      replyInterpreterInput: value.replyInterpreterInput,
    })
      .filter(([, candidate]) => candidate !== undefined)
      .map(([key]) => key)

    if (providedKeys.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Manager input must provide exactly one task-specific payload',
      })
      return
    }

    const expectedKey = expectedKeyByTask[value.task]
    if (providedKeys[0] !== expectedKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Manager input task "${value.task}" must use "${expectedKey}"`,
      })
    }
  })

export const ManagerOutputSchema = z
  .object({
    task: GtmAgentTaskSchema,
    handledBy: GtmAgentTaskSchema,
    validated: z.literal(true),
    validationSummary: trimmedString.max(240),
    leadDiscovery: LeadDiscoveryOutputSchema.optional(),
    leadReview: LeadReviewOutputSchema.optional(),
    outreachWriter: OutreachWriterOutputSchema.optional(),
    replyInterpreter: ReplyInterpreterOutputSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedOutputKeyByTask = {
      lead_discovery: 'leadDiscovery',
      lead_review: 'leadReview',
      outreach_writer: 'outreachWriter',
      reply_interpreter: 'replyInterpreter',
    } as const

    if (value.task !== value.handledBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Manager handledBy must match task',
      })
    }

    const providedKeys = Object.entries({
      leadDiscovery: value.leadDiscovery,
      leadReview: value.leadReview,
      outreachWriter: value.outreachWriter,
      replyInterpreter: value.replyInterpreter,
    })
      .filter(([, candidate]) => candidate !== undefined)
      .map(([key]) => key)

    if (providedKeys.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Manager output must include exactly one validated sub-agent result',
      })
      return
    }

    const expectedKey = expectedOutputKeyByTask[value.task]
    if (providedKeys[0] !== expectedKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Manager task "${value.task}" must populate "${expectedKey}"`,
      })
    }
  })

export type GtmAgentTask = z.infer<typeof GtmAgentTaskSchema>
export type GtmAgentToolScope = z.infer<typeof GtmAgentToolScopeSchema>
export type CandidateBusiness = z.infer<typeof CandidateBusinessSchema>
export type LeadDiscoveryInput = z.infer<typeof LeadDiscoveryInputSchema>
export type LeadDiscoveryOutput = z.infer<typeof LeadDiscoveryOutputSchema>
export type LeadReviewInput = z.infer<typeof LeadReviewInputSchema>
export type LeadReviewOutput = z.infer<typeof LeadReviewOutputSchema>
export type OutreachWriterInput = z.infer<typeof OutreachWriterInputSchema>
export type OutreachWriterOutput = z.infer<typeof OutreachWriterOutputSchema>
export type ReplyInterpreterInput = z.infer<typeof ReplyInterpreterInputSchema>
export type ReplyInterpreterOutput = z.infer<typeof ReplyInterpreterOutputSchema>
export type RuntimeToolStubOutput = z.infer<typeof RuntimeToolStubOutputSchema>
export type ManagerInput = z.infer<typeof ManagerInputSchema>
export type ManagerOutput = z.infer<typeof ManagerOutputSchema>

export function parseLeadDiscoveryInput(value: unknown): LeadDiscoveryInput {
  return LeadDiscoveryInputSchema.parse(parseJsonLike(value))
}

export function parseLeadDiscoveryOutput(value: unknown): LeadDiscoveryOutput {
  return LeadDiscoveryOutputSchema.parse(parseJsonLike(value))
}

export function parseLeadReviewInput(value: unknown): LeadReviewInput {
  return LeadReviewInputSchema.parse(parseJsonLike(value))
}

export function parseLeadReviewOutput(value: unknown): LeadReviewOutput {
  return LeadReviewOutputSchema.parse(parseJsonLike(value))
}

export function parseOutreachWriterInput(value: unknown): OutreachWriterInput {
  return OutreachWriterInputSchema.parse(parseJsonLike(value))
}

export function parseOutreachWriterOutput(
  value: unknown,
  options: { maxWords?: number } = {}
): OutreachWriterOutput {
  const parsed = OutreachWriterOutputSchema.parse(parseJsonLike(value))
  assertPlainTextBody(parsed.body)
  assertBodyWordLimit(parsed.body, options.maxWords ?? 70)
  return parsed
}

export function parseReplyInterpreterInput(value: unknown): ReplyInterpreterInput {
  return ReplyInterpreterInputSchema.parse(parseJsonLike(value))
}

export function parseReplyInterpreterOutput(value: unknown): ReplyInterpreterOutput {
  return ReplyInterpreterOutputSchema.parse(parseJsonLike(value))
}

export function parseRuntimeToolStubOutput(value: unknown): RuntimeToolStubOutput {
  return RuntimeToolStubOutputSchema.parse(parseJsonLike(value))
}

export function parseManagerInput(value: unknown): ManagerInput {
  return ManagerInputSchema.parse(parseJsonLike(value))
}

export function parseManagerOutput(
  value: unknown,
  options: { outreachWriterMaxWords?: number } = {}
): ManagerOutput {
  const parsed = ManagerOutputSchema.parse(parseJsonLike(value))

  if (parsed.outreachWriter) {
    parseOutreachWriterOutput(parsed.outreachWriter, {
      maxWords: options.outreachWriterMaxWords,
    })
  }

  return parsed
}


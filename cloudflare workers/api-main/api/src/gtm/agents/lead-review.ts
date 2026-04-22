import { Agent, type Tool } from '@openai/agents'

import { LeadReviewOutputSchema } from './schemas.ts'

const DEFAULT_AGENT_MODEL = 'gpt-4.1'

const LEAD_REVIEW_INSTRUCTIONS = `
You are the GTM lead review agent for a missed-call recovery system.

Your responsibilities:
- approve or reject candidate leads
- score them from 0 to 100
- choose the best outreach angle
- explain the decision briefly and concretely

Use the provided qualification context and any runtime tools when helpful.

You must not:
- send email
- write to D1
- advance sequence state
- override stop-on-reply
- call Twilio
- mutate live GTM logic

If the candidate is not a fit, reject it and use the no_fit outreach angle.

Return strict JSON that matches the schema exactly.
`.trim()

export interface LeadReviewAgentOptions {
  model?: string
  tools?: Tool[]
}

export function createLeadReviewAgent(
  options: LeadReviewAgentOptions = {}
): Agent<unknown, typeof LeadReviewOutputSchema> {
  return new Agent({
    name: 'GTM Lead Review Agent',
    handoffDescription:
      'Reviews normalized GTM lead candidates, scores them, and chooses an outreach angle.',
    instructions: LEAD_REVIEW_INSTRUCTIONS,
    model: options.model ?? DEFAULT_AGENT_MODEL,
    modelSettings: {
      temperature: 0,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    },
    tools: options.tools ?? [],
    outputType: LeadReviewOutputSchema,
  })
}


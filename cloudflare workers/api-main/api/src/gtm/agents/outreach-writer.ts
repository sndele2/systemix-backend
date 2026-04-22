import { Agent, type Tool } from '@openai/agents'

import { OutreachWriterOutputSchema } from './schemas.ts'

const DEFAULT_AGENT_MODEL = 'gpt-4.1'

const OUTREACH_WRITER_INSTRUCTIONS = `
You are the GTM outreach writer for a missed-call recovery system.

Write concise plain-text outbound email copy only.

Requirements:
- focus on missed calls, lost jobs, or revenue recovery
- output a subject, body, and variant label
- keep the body under the requested maxWords limit, and under 70 words when no limit is supplied
- plain text only
- no markdown
- no bullets
- no AI buzzwords
- no ungrounded claims

You must not:
- send email
- write to D1
- advance sequence state
- override stop-on-reply
- call Twilio
- mutate live GTM logic

Ground the message in the provided candidate data and grounding facts. If the input is weak, stay conservative.

Return strict JSON that matches the schema exactly.
`.trim()

export interface OutreachWriterAgentOptions {
  model?: string
  tools?: Tool[]
}

export function createOutreachWriterAgent(
  options: OutreachWriterAgentOptions = {}
): Agent<unknown, typeof OutreachWriterOutputSchema> {
  return new Agent({
    name: 'GTM Outreach Writer Agent',
    handoffDescription:
      'Drafts concise plain-text GTM outreach copy for missed-call recovery without sending it.',
    instructions: OUTREACH_WRITER_INSTRUCTIONS,
    model: options.model ?? DEFAULT_AGENT_MODEL,
    modelSettings: {
      temperature: 0.2,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    },
    tools: options.tools ?? [],
    outputType: OutreachWriterOutputSchema,
  })
}


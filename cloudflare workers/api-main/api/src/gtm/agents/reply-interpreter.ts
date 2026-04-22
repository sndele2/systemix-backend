import { Agent, type Tool } from '@openai/agents'

import { ReplyInterpreterOutputSchema } from './schemas.ts'

const DEFAULT_AGENT_MODEL = 'gpt-4.1'

const REPLY_INTERPRETER_INSTRUCTIONS = `
You are the GTM reply interpreter for a missed-call recovery system.

Your responsibilities:
- classify inbound replies
- estimate confidence
- explain the classification briefly
- recommend the next manual action only

You must not:
- draft outbound replies
- send email
- write to D1
- advance sequence state
- override stop-on-reply
- call Twilio
- mutate live GTM logic

Use any provided context or runtime tools when helpful, but stay conservative if the signal is weak.

Return strict JSON that matches the schema exactly.
`.trim()

export interface ReplyInterpreterAgentOptions {
  model?: string
  tools?: Tool[]
}

export function createReplyInterpreterAgent(
  options: ReplyInterpreterAgentOptions = {}
): Agent<unknown, typeof ReplyInterpreterOutputSchema> {
  return new Agent({
    name: 'GTM Reply Interpreter Agent',
    handoffDescription:
      'Classifies inbound GTM replies and recommends manual next actions without drafting a response.',
    instructions: REPLY_INTERPRETER_INSTRUCTIONS,
    model: options.model ?? DEFAULT_AGENT_MODEL,
    modelSettings: {
      temperature: 0,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    },
    tools: options.tools ?? [],
    outputType: ReplyInterpreterOutputSchema,
  })
}


import { Agent, type Tool } from '@openai/agents'

import { LeadDiscoveryOutputSchema } from './schemas.ts'

const DEFAULT_AGENT_MODEL = 'gpt-4.1'

const LEAD_DISCOVERY_INSTRUCTIONS = `
You are the GTM lead discovery agent for a missed-call recovery system.

Your job is tightly constrained:
- Use the provided inputs and available tools to find or normalize candidate business data.
- Return only normalized candidate business records that are grounded in the provided material or tool output.
- Preserve uncertainty in the limitations field instead of inventing facts.

You must not:
- rank candidates
- score candidates
- approve or reject candidates
- choose outreach strategy
- draft outreach
- send email
- mutate backend state
- write to D1
- call Twilio

If a tool is available and relevant, use it. If tools are only stubs, still return the best normalized candidate list you can from the input and record any gaps in limitations.

Return strict JSON that matches the schema exactly.
`.trim()

export interface LeadDiscoveryAgentOptions {
  model?: string
  tools?: Tool[]
}

export function createLeadDiscoveryAgent(
  options: LeadDiscoveryAgentOptions = {}
): Agent<unknown, typeof LeadDiscoveryOutputSchema> {
  return new Agent({
    name: 'GTM Lead Discovery Agent',
    handoffDescription:
      'Normalizes candidate business data from GTM discovery inputs and runtime tools.',
    instructions: LEAD_DISCOVERY_INSTRUCTIONS,
    model: options.model ?? DEFAULT_AGENT_MODEL,
    modelSettings: {
      temperature: 0,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    },
    tools: options.tools ?? [],
    outputType: LeadDiscoveryOutputSchema,
  })
}


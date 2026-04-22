import { Agent, tool } from '@openai/agents'

import {
  LeadDiscoveryInputSchema,
  LeadReviewInputSchema,
  ManagerOutputSchema,
  OutreachWriterInputSchema,
  ReplyInterpreterInputSchema,
  type LeadDiscoveryInput,
  type LeadDiscoveryOutput,
  type LeadReviewInput,
  type LeadReviewOutput,
  type OutreachWriterInput,
  type OutreachWriterOutput,
  type ReplyInterpreterInput,
  type ReplyInterpreterOutput,
  parseLeadDiscoveryOutput,
  parseLeadReviewOutput,
  parseOutreachWriterOutput,
  parseReplyInterpreterOutput,
} from './schemas.ts'

const DEFAULT_AGENT_MODEL = 'gpt-4.1'

const MANAGER_INSTRUCTIONS = `
You are the GTM manager agent.

You stay in control and route work to exactly one sub-agent tool:
- lead discovery
- lead review
- outreach writer
- reply interpreter

Rules:
- choose the tool that matches the incoming task
- call exactly one sub-agent tool for each task
- do not bypass the sub-agent tools
- do not invent a sub-agent result when a tool is available
- return the validated sub-agent output in the matching output field only
- set validated to true
- keep handledBy equal to task

Hard constraints:
- never send email
- never write to D1
- never advance sequence state
- never override stop-on-reply
- never call Twilio
- never mutate live GTM logic

Return strict JSON that matches the schema exactly.
`.trim()

export interface ManagerAgentDependencies {
  model?: string
  runLeadDiscovery: (input: LeadDiscoveryInput) => Promise<LeadDiscoveryOutput>
  runLeadReview: (input: LeadReviewInput) => Promise<LeadReviewOutput>
  runOutreachWriter: (input: OutreachWriterInput) => Promise<OutreachWriterOutput>
  runReplyInterpreter: (input: ReplyInterpreterInput) => Promise<ReplyInterpreterOutput>
}

export function createManagerAgent(
  dependencies: ManagerAgentDependencies
): Agent<unknown, typeof ManagerOutputSchema> {
  const leadDiscoveryTool = tool({
    name: 'delegate_lead_discovery_agent',
    description:
      'Routes GTM lead discovery work to the lead discovery sub-agent and returns validated JSON.',
    parameters: LeadDiscoveryInputSchema,
    execute: async (input) => {
      const result = await dependencies.runLeadDiscovery(input)
      return JSON.stringify(parseLeadDiscoveryOutput(result))
    },
  })

  const leadReviewTool = tool({
    name: 'delegate_lead_review_agent',
    description:
      'Routes GTM lead review work to the lead review sub-agent and returns validated JSON.',
    parameters: LeadReviewInputSchema,
    execute: async (input) => {
      const result = await dependencies.runLeadReview(input)
      return JSON.stringify(parseLeadReviewOutput(result))
    },
  })

  const outreachWriterTool = tool({
    name: 'delegate_outreach_writer_agent',
    description:
      'Routes GTM outreach drafting work to the outreach writer sub-agent and returns validated JSON.',
    parameters: OutreachWriterInputSchema,
    execute: async (input) => {
      const result = await dependencies.runOutreachWriter(input)
      return JSON.stringify(
        parseOutreachWriterOutput(result, {
          maxWords: input.maxWords,
        })
      )
    },
  })

  const replyInterpreterTool = tool({
    name: 'delegate_reply_interpreter_agent',
    description:
      'Routes inbound reply analysis to the reply interpreter sub-agent and returns validated JSON.',
    parameters: ReplyInterpreterInputSchema,
    execute: async (input) => {
      const result = await dependencies.runReplyInterpreter(input)
      return JSON.stringify(parseReplyInterpreterOutput(result))
    },
  })

  return new Agent({
    name: 'GTM Manager Agent',
    handoffDescription:
      'Routes GTM decision tasks to the correct sub-agent tool and returns validated structured output.',
    instructions: MANAGER_INSTRUCTIONS,
    model: dependencies.model ?? DEFAULT_AGENT_MODEL,
    modelSettings: {
      temperature: 0,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    },
    tools: [leadDiscoveryTool, leadReviewTool, outreachWriterTool, replyInterpreterTool],
    outputType: ManagerOutputSchema,
  })
}


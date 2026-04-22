import { OpenAIProvider, Runner, tool, type ModelProvider, type Tool } from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'

import { createLeadDiscoveryAgent } from './lead-discovery.ts'
import { createLeadReviewAgent } from './lead-review.ts'
import { createManagerAgent } from './manager.ts'
import { createOutreachWriterAgent } from './outreach-writer.ts'
import { createReplyInterpreterAgent } from './reply-interpreter.ts'
import {
  RuntimeToolStubOutputSchema,
  type GtmAgentToolScope,
  type LeadDiscoveryInput,
  type LeadDiscoveryOutput,
  type LeadReviewInput,
  type LeadReviewOutput,
  type ManagerInput,
  type ManagerOutput,
  type OutreachWriterInput,
  type OutreachWriterOutput,
  type ReplyInterpreterInput,
  type ReplyInterpreterOutput,
  parseLeadDiscoveryInput,
  parseLeadDiscoveryOutput,
  parseLeadReviewInput,
  parseLeadReviewOutput,
  parseManagerInput,
  parseManagerOutput,
  parseOutreachWriterInput,
  parseOutreachWriterOutput,
  parseReplyInterpreterInput,
  parseReplyInterpreterOutput,
} from './schemas.ts'

const DEFAULT_AGENT_MODEL = 'gpt-4.1'
const DEFAULT_MAX_TURNS = 8

const runtimeToolParametersSchema = z.object({}).catchall(z.unknown())

export interface RuntimeAgentToolDefinition {
  name: string
  description: string
  scopes: GtmAgentToolScope[]
  parameters?: z.ZodObject<any>
}

export interface GtmAgentRunnerOptions {
  model?: string
  maxTurns?: number
  runtimeTools?: RuntimeAgentToolDefinition[]
  modelProvider?: ModelProvider
  openAIClient?: OpenAI
  apiKey?: string
}

interface AgentRuntime {
  model: string
  maxTurns: number
  runner: Runner
  runtimeTools: RuntimeAgentToolDefinition[]
}

function resolveModelProvider(options: GtmAgentRunnerOptions): ModelProvider {
  if (options.modelProvider) {
    return options.modelProvider
  }

  if (options.openAIClient || options.apiKey) {
    return new OpenAIProvider({
      openAIClient: options.openAIClient,
      apiKey: options.apiKey,
      useResponses: true,
    })
  }

  throw new Error('GTM agent runner requires modelProvider, openAIClient, or apiKey')
}

function createRuntime(options: GtmAgentRunnerOptions): AgentRuntime {
  return {
    model: options.model ?? DEFAULT_AGENT_MODEL,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    runtimeTools: options.runtimeTools ?? [],
    runner: new Runner({
      model: options.model ?? DEFAULT_AGENT_MODEL,
      modelProvider: resolveModelProvider(options),
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      workflowName: 'gtm-agent-layer',
    }),
  }
}

function buildTaskPrompt(taskName: string, payload: unknown): string {
  return [
    `Task: ${taskName}`,
    'Return only strict JSON that matches your configured output schema.',
    'Input:',
    JSON.stringify(payload, null, 2),
  ].join('\n\n')
}

function scopeMatches(
  scopes: GtmAgentToolScope[],
  allowedScopes: readonly GtmAgentToolScope[]
): boolean {
  return scopes.some((scope) => allowedScopes.includes(scope))
}

function buildRuntimeToolStubs(
  definitions: RuntimeAgentToolDefinition[],
  allowedScopes: readonly GtmAgentToolScope[]
): Tool[] {
  return definitions
    .filter((definition) => scopeMatches(definition.scopes, allowedScopes))
    .map((definition) =>
      tool({
        name: definition.name,
        description: `${definition.description} TODO: runtime tool stub only; wire the live implementation in runner.ts later.`,
        parameters: definition.parameters ?? runtimeToolParametersSchema,
        execute: async (input) =>
          JSON.stringify(
            RuntimeToolStubOutputSchema.parse({
              status: 'todo',
              toolName: definition.name,
              note: 'TODO: replace this stub with a live runtime tool binding in the runner.',
              receivedInput: input,
            })
          ),
      })
    )
}

async function runLeadDiscoveryWithRuntime(
  runtime: AgentRuntime,
  input: LeadDiscoveryInput
): Promise<LeadDiscoveryOutput> {
  const agent = createLeadDiscoveryAgent({
    model: runtime.model,
    tools: buildRuntimeToolStubs(runtime.runtimeTools, ['shared', 'lead_discovery']),
  })

  const result = await runtime.runner.run(agent, buildTaskPrompt('lead_discovery', input), {
    maxTurns: runtime.maxTurns,
  })

  return parseLeadDiscoveryOutput(result.finalOutput)
}

async function runLeadReviewWithRuntime(
  runtime: AgentRuntime,
  input: LeadReviewInput
): Promise<LeadReviewOutput> {
  const agent = createLeadReviewAgent({
    model: runtime.model,
    tools: buildRuntimeToolStubs(runtime.runtimeTools, ['shared', 'lead_review']),
  })

  const result = await runtime.runner.run(agent, buildTaskPrompt('lead_review', input), {
    maxTurns: runtime.maxTurns,
  })

  return parseLeadReviewOutput(result.finalOutput)
}

async function runOutreachWriterWithRuntime(
  runtime: AgentRuntime,
  input: OutreachWriterInput
): Promise<OutreachWriterOutput> {
  const agent = createOutreachWriterAgent({
    model: runtime.model,
    tools: buildRuntimeToolStubs(runtime.runtimeTools, ['shared', 'outreach_writer']),
  })

  const result = await runtime.runner.run(agent, buildTaskPrompt('outreach_writer', input), {
    maxTurns: runtime.maxTurns,
  })

  return parseOutreachWriterOutput(result.finalOutput, {
    maxWords: input.maxWords,
  })
}

async function runReplyInterpreterWithRuntime(
  runtime: AgentRuntime,
  input: ReplyInterpreterInput
): Promise<ReplyInterpreterOutput> {
  const agent = createReplyInterpreterAgent({
    model: runtime.model,
    tools: buildRuntimeToolStubs(runtime.runtimeTools, ['shared', 'reply_interpreter']),
  })

  const result = await runtime.runner.run(agent, buildTaskPrompt('reply_interpreter', input), {
    maxTurns: runtime.maxTurns,
  })

  return parseReplyInterpreterOutput(result.finalOutput)
}

export async function runLeadDiscovery(
  input: LeadDiscoveryInput,
  options: GtmAgentRunnerOptions
): Promise<LeadDiscoveryOutput> {
  const runtime = createRuntime(options)
  const validatedInput = parseLeadDiscoveryInput(input)
  return runLeadDiscoveryWithRuntime(runtime, validatedInput)
}

export async function runLeadReview(
  input: LeadReviewInput,
  options: GtmAgentRunnerOptions
): Promise<LeadReviewOutput> {
  const runtime = createRuntime(options)
  const validatedInput = parseLeadReviewInput(input)
  return runLeadReviewWithRuntime(runtime, validatedInput)
}

export async function runOutreachWriter(
  input: OutreachWriterInput,
  options: GtmAgentRunnerOptions
): Promise<OutreachWriterOutput> {
  const runtime = createRuntime(options)
  const validatedInput = parseOutreachWriterInput(input)
  return runOutreachWriterWithRuntime(runtime, validatedInput)
}

export async function runReplyInterpreter(
  input: ReplyInterpreterInput,
  options: GtmAgentRunnerOptions
): Promise<ReplyInterpreterOutput> {
  const runtime = createRuntime(options)
  const validatedInput = parseReplyInterpreterInput(input)
  return runReplyInterpreterWithRuntime(runtime, validatedInput)
}

export async function runManagerTask(
  input: ManagerInput,
  options: GtmAgentRunnerOptions
): Promise<ManagerOutput> {
  const runtime = createRuntime(options)
  const validatedInput = parseManagerInput(input)

  const manager = createManagerAgent({
    model: runtime.model,
    runLeadDiscovery: (taskInput) => runLeadDiscoveryWithRuntime(runtime, taskInput),
    runLeadReview: (taskInput) => runLeadReviewWithRuntime(runtime, taskInput),
    runOutreachWriter: (taskInput) => runOutreachWriterWithRuntime(runtime, taskInput),
    runReplyInterpreter: (taskInput) => runReplyInterpreterWithRuntime(runtime, taskInput),
  })

  const result = await runtime.runner.run(manager, buildTaskPrompt('manager', validatedInput), {
    maxTurns: runtime.maxTurns,
  })

  return parseManagerOutput(result.finalOutput, {
    outreachWriterMaxWords: validatedInput.outreachWriterInput?.maxWords,
  })
}


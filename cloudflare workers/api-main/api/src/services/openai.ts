import { z } from 'zod';

export type AiLeadClassification = 'emergency' | 'inquiry' | 'spam';
export type AiLeadConfidence = 'high' | 'low';
export type AiLeadSource = 'gpt' | 'gpt_fallback';

export type AiLeadClassificationResult = {
  classification: AiLeadClassification;
  summary: string;
  confidence: AiLeadConfidence;
  source: AiLeadSource;
  gptUsed: boolean;
};

const OPENAI_RESPONSE_SCHEMA = z.object({
  classification: z.enum(['emergency', 'inquiry', 'spam']),
  summary: z.string().trim().min(1),
  confidence: z.enum(['high', 'low']),
});

const MAX_SUMMARY_LENGTH = 140;

function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function ensureSentence(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.length <= MAX_SUMMARY_LENGTH) {
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }

  const truncated = trimmed.slice(0, MAX_SUMMARY_LENGTH - 3).trimEnd();
  return `${truncated}...`;
}

function normalizeClassification(value: unknown): AiLeadClassification | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'standard') {
    return 'inquiry';
  }

  if (normalized === 'emergency' || normalized === 'inquiry' || normalized === 'spam') {
    return normalized;
  }

  return null;
}

export function buildLeadSummary(
  classification: AiLeadClassification,
  messageBody: string
): string {
  const normalizedBody = messageBody.replace(/\s+/g, ' ').trim();
  const clippedBody =
    normalizedBody.length > 80
      ? `${normalizedBody.slice(0, 77).trimEnd()}...`
      : normalizedBody || 'No message content provided';

  switch (classification) {
    case 'emergency':
      return ensureSentence(`Customer reports an emergency home-service issue: ${clippedBody}`);
    case 'spam':
      return ensureSentence(`Message appears unrelated to a legitimate home-service lead: ${clippedBody}`);
    case 'inquiry':
    default:
      return ensureSentence(`Customer is requesting home-service help or information: ${clippedBody}`);
  }
}

function buildFallbackResult(
  classification: AiLeadClassification,
  messageBody: string,
  gptUsed: boolean
): AiLeadClassificationResult {
  return {
    classification,
    summary: buildLeadSummary(classification, messageBody),
    confidence: 'low',
    source: 'gpt_fallback',
    gptUsed,
  };
}

export async function classifyLeadIntent(
  messageBody: string,
  apiKey?: string
): Promise<AiLeadClassificationResult> {
  if (!apiKey) {
    return buildFallbackResult('emergency', messageBody, false);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Classify inbound home-service SMS leads. Return only strict JSON that exactly matches this schema: {"classification":"emergency"|"inquiry"|"spam","summary":string,"confidence":"high"|"low"}. The summary must be exactly one sentence describing the customer intent with no extra keys or commentary.',
          },
          {
            role: 'user',
            content: `Message: ${messageBody}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('GPT lead classifier failed', {
        status: response.status,
        detail,
      });
      return buildFallbackResult('emergency', messageBody, true);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(content) as Record<string, unknown> | null;

    const classification = normalizeClassification(parsed?.classification);
    const confidence = parsed?.confidence === 'high' ? 'high' : 'low';
    const summary = ensureSentence(
      typeof parsed?.summary === 'string' ? parsed.summary : buildLeadSummary(classification || 'emergency', messageBody)
    );

    const result = OPENAI_RESPONSE_SCHEMA.safeParse({
      classification: classification || 'emergency',
      summary,
      confidence,
    });

    if (!result.success) {
      console.error('GPT lead classifier returned invalid schema', {
        issues: result.error.issues,
        content,
      });
      return buildFallbackResult(classification || 'emergency', messageBody, true);
    }

    return {
      ...result.data,
      source: 'gpt',
      gptUsed: true,
    };
  } catch (error) {
    console.error('GPT lead classifier error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return buildFallbackResult('emergency', messageBody, true);
  } finally {
    clearTimeout(timeout);
  }
}

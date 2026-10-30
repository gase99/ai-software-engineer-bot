import { postJson } from '../http.js';
import type { AiCompletion, AiCompletionRequest, AiMessage, AiToolCall, ProviderHealth } from '../types.js';
import { AiProviderError } from '../types.js';

interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ChatToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** OpenAI-style messages: `tool_calls` on the assistant, `tool_call_id` on the result. */
function toOpenAiMessages(messages: AiMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? message.toolName ?? 'tool',
        content: message.content || '(empty result)',
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A malformed argument string must never crash the turn; the tool layer
    // will reject the call and the model sees a normal error result.
    return { __raw: raw };
  }
}

/**
 * OpenAI-compatible Chat Completions (Groq, OpenRouter, DeepSeek, OpenAI).
 * One implementation, four free/paid providers - the only differences are the
 * base URL, the model name and an optional extra header.
 */
export async function completeOpenAiCompatible(input: {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  request: AiCompletionRequest;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<AiCompletion> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: toOpenAiMessages(input.request.messages),
    temperature: input.request.temperature ?? 0.2,
    max_tokens: input.request.maxOutputTokens ?? 4096,
  };
  if (input.request.jsonMode) body.response_format = { type: 'json_object' };
  if (input.request.tools?.length) {
    body.tools = input.request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = 'auto';
  }

  const data = await postJson<ChatResponse>({
    url: `${input.baseUrl}/chat/completions`,
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      ...(input.provider === 'openrouter'
        ? { 'HTTP-Referer': 'https://github.com/gase99/ai-software-engineer-bot', 'X-Title': 'AI Software Engineer Bot' }
        : {}),
      ...(input.extraHeaders ?? {}),
    },
    body,
    timeoutMs: input.timeoutMs,
    provider: input.provider,
    fetchImpl: input.fetchImpl,
  });

  const choice = data.choices?.[0];
  const text = (choice?.message?.content ?? '').trim();
  const toolCalls: AiToolCall[] = (choice?.message?.tool_calls ?? [])
    .filter((call) => call.function?.name)
    .map((call, index) => ({
      id: call.id ?? `${input.provider}_${index}`,
      name: call.function!.name as string,
      arguments: parseArguments(call.function!.arguments),
    }));

  if (!text && !toolCalls.length) {
    throw new AiProviderError(`${input.provider} returned an empty completion`, input.provider, 502, true);
  }
  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    provider: input.provider,
    model: input.model,
    finishReason: choice?.finish_reason,
  };
}

export async function testOpenAiCompatible(input: {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<ProviderHealth> {
  const started = Date.now();
  try {
    const result = await completeOpenAiCompatible({
      ...input,
      request: { messages: [{ role: 'user', content: 'Say OK' }], maxOutputTokens: 16 },
    });
    return {
      ok: true,
      status: 'ok',
      latencyMs: Date.now() - started,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (error) {
    const err = error as AiProviderError;
    return { ok: false, status: String(err.status ?? 'error'), latencyMs: Date.now() - started, error: err.message };
  }
}

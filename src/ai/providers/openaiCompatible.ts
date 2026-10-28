import { postJson } from '../http.js';
import type { AiCompletion, AiCompletionRequest, ProviderHealth } from '../types.js';
import { AiProviderError } from '../types.js';

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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
    messages: input.request.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: input.request.temperature ?? 0.2,
    max_tokens: input.request.maxOutputTokens ?? 4096,
  };
  if (input.request.jsonMode) body.response_format = { type: 'json_object' };

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

  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new AiProviderError(`${input.provider} returned an empty completion`, input.provider, 502, true);
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    provider: input.provider,
    model: input.model,
    finishReason: data.choices?.[0]?.finish_reason,
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
    return { ok: true, status: 'ok', latencyMs: Date.now() - started, model: result.model };
  } catch (error) {
    const err = error as AiProviderError;
    return { ok: false, status: String(err.status ?? 'error'), latencyMs: Date.now() - started, error: err.message };
  }
}

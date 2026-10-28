import { postJson } from '../http.js';
import type { AiCompletion, AiCompletionRequest, ProviderHealth } from '../types.js';
import { AiProviderError } from '../types.js';

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/** Anthropic Messages API (paid, opt-in only - never used as a fallback). */
export async function completeAnthropic(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  request: AiCompletionRequest;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<AiCompletion> {
  const system = input.request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const data = await postJson<AnthropicResponse>({
    url: `${input.baseUrl}/messages`,
    headers: {
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: input.model,
      max_tokens: input.request.maxOutputTokens ?? 4096,
      ...(system ? { system } : {}),
      messages: input.request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    },
    timeoutMs: input.timeoutMs,
    provider: 'anthropic',
    fetchImpl: input.fetchImpl,
  });

  const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  if (!text) throw new AiProviderError('anthropic returned an empty completion', 'anthropic', 502, true);
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    provider: 'anthropic',
    model: input.model,
    finishReason: data.stop_reason,
  };
}

export async function testAnthropic(input: { apiKey: string; baseUrl: string; model: string; timeoutMs: number; fetchImpl?: typeof fetch }): Promise<ProviderHealth> {
  const started = Date.now();
  try {
    const result = await completeAnthropic({
      ...input,
      request: { messages: [{ role: 'user', content: 'Say OK' }], maxOutputTokens: 16 },
    });
    return { ok: true, status: 'ok', latencyMs: Date.now() - started, model: result.model };
  } catch (error) {
    const err = error as AiProviderError;
    return { ok: false, status: String(err.status ?? 'error'), latencyMs: Date.now() - started, error: err.message };
  }
}

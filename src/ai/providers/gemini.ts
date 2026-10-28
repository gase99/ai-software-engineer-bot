import { postJson } from '../http.js';
import type { AiCompletion, AiCompletionRequest, ProviderHealth } from '../types.js';
import { AiProviderError } from '../types.js';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

/** Google Gemini `generateContent` (free tier friendly). */
export async function completeGemini(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  request: AiCompletionRequest;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<AiCompletion> {
  const system = input.request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = input.request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const url = `${input.baseUrl}/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;
  const body: Record<string, unknown> = {
    contents: contents.length ? contents : [{ role: 'user', parts: [{ text: 'سلام' }] }],
    generationConfig: {
      temperature: input.request.temperature ?? 0.2,
      maxOutputTokens: input.request.maxOutputTokens ?? 4096,
      ...(input.request.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const data = await postJson<GeminiResponse>({
    url,
    body,
    timeoutMs: input.timeoutMs,
    provider: 'gemini',
    fetchImpl: input.fetchImpl,
  });

  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) {
    // The key travels in the URL: never echo the request URL back to the user.
    throw new AiProviderError('gemini returned an empty completion', 'gemini', 502, true);
  }
  return {
    text,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    provider: 'gemini',
    model: input.model,
    finishReason: data.candidates?.[0]?.finishReason,
  };
}

export async function testGemini(input: { apiKey: string; baseUrl: string; model: string; timeoutMs: number; fetchImpl?: typeof fetch }): Promise<ProviderHealth> {
  const started = Date.now();
  try {
    const result = await completeGemini({
      ...input,
      request: { messages: [{ role: 'user', content: 'Say OK' }], maxOutputTokens: 16 },
    });
    return { ok: true, status: 'ok', latencyMs: Date.now() - started, model: result.model };
  } catch (error) {
    const err = error as AiProviderError;
    return { ok: false, status: String(err.status ?? 'error'), latencyMs: Date.now() - started, error: err.message };
  }
}

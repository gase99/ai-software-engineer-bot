import { postJson } from '../http.js';
import type { AiCompletion, AiCompletionRequest, AiMessage, AiToolCall, ProviderHealth } from '../types.js';
import { AiProviderError } from '../types.js';

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
}

/**
 * Gemini's `Schema` proto is a subset of JSON Schema: keywords such as
 * `additionalProperties`, `$schema` or `title` make the request fail with 400.
 * Tool definitions are written once (provider-neutral) and sanitised here.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
]);

export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = toGeminiSchema(child as Record<string, unknown>);
      }
      output.properties = properties;
      continue;
    }
    if (key === 'items' && value && typeof value === 'object') {
      output.items = toGeminiSchema(value as Record<string, unknown>);
      continue;
    }
    output[key] = value;
  }
  return output;
}

/**
 * Gemini speaks `contents` + `parts`, not role/content. This adapter is the only
 * place that knows the mapping, so the rest of the codebase (agent, tools,
 * memory) works with one provider-neutral message shape.
 */
function toGeminiContents(messages: AiMessage[]): Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'tool') {
        // Gemini has no "tool" role: results are returned as a user turn.
        return {
          role: 'user' as const,
          parts: [
            {
              functionResponse: {
                name: message.toolName ?? 'tool',
                response: { result: message.content || '(empty result)' },
              },
            },
          ],
        };
      }

      if (message.role === 'assistant') {
        const parts: GeminiPart[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
        }
        // Gemini rejects empty parts arrays.
        return { role: 'model' as const, parts: parts.length ? parts : [{ text: '(empty)' }] };
      }

      return { role: 'user' as const, parts: [{ text: message.content }] };
    });
}

/** Google Gemini `generateContent` (free tier friendly) with function calling. */
export async function completeGemini(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  request: AiCompletionRequest;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<AiCompletion> {
  const system = input.request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = toGeminiContents(input.request.messages);

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
  if (input.request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: input.request.tools.map((tool) => {
          const parameters = toGeminiSchema(tool.parameters);
          const empty = !parameters.properties || Object.keys(parameters.properties as object).length === 0;
          // A no-argument tool must omit `parameters` entirely: Gemini rejects an
          // OBJECT schema with an empty `properties` map.
          return {
            name: tool.name,
            description: tool.description,
            ...(empty ? {} : { parameters }),
          };
        }),
      },
    ];
  }

  const data = await postJson<GeminiResponse>({
    url,
    body,
    timeoutMs: input.timeoutMs,
    provider: 'gemini',
    fetchImpl: input.fetchImpl,
  });

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? '').join('').trim();
  const toolCalls: AiToolCall[] = parts
    .filter((part) => part.functionCall?.name)
    .map((part, index) => ({
      id: `gem_${index}_${Math.random().toString(36).slice(2, 8)}`,
      name: part.functionCall!.name as string,
      arguments: part.functionCall!.args ?? {},
    }));

  if (!text && !toolCalls.length) {
    // The key travels in the URL: never echo the request URL back to the user.
    throw new AiProviderError('gemini returned an empty completion', 'gemini', 502, true);
  }
  return {
    // Gemini often returns "I will call X" text next to the call; keep it, the
    // agent decides whether to surface it to the owner.
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
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

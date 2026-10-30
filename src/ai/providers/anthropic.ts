import { postJson } from '../http.js';
import type { AiCompletion, AiCompletionRequest, AiMessage, AiToolCall, ProviderHealth } from '../types.js';
import { AiProviderError } from '../types.js';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/** Anthropic content blocks: `tool_use` out, `tool_result` back in. */
function toAnthropicMessages(messages: AiMessage[]): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId ?? message.toolName ?? 'tool',
              content: message.content || '(empty result)',
              ...(message.toolError ? { is_error: true } : {}),
            },
          ],
        };
      }
      if (message.role === 'assistant' && message.toolCalls?.length) {
        const content: AnthropicBlock[] = [];
        if (message.content) content.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls) {
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
        }
        return { role: 'assistant' as const, content };
      }
      return { role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: message.content };
    });
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
      messages: toAnthropicMessages(input.request.messages),
      ...(input.request.tools?.length
        ? {
            tools: input.request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
    },
    timeoutMs: input.timeoutMs,
    provider: 'anthropic',
    fetchImpl: input.fetchImpl,
  });

  const blocks = data.content ?? [];
  const text = blocks.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
  const toolCalls: AiToolCall[] = blocks
    .filter((block) => block.type === 'tool_use' && block.name)
    .map((block, index) => ({
      id: block.id ?? `ant_${index}`,
      name: block.name as string,
      arguments: block.input ?? {},
    }));

  if (!text && !toolCalls.length) {
    throw new AiProviderError('anthropic returned an empty completion', 'anthropic', 502, true);
  }
  return {
    text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
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

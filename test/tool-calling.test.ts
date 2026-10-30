import { describe, expect, it } from 'vitest';
import { FetchMock, jsonResponse } from './helpers.js';
import { completeGemini, toGeminiSchema } from '../src/ai/providers/gemini.js';
import { completeOpenAiCompatible } from '../src/ai/providers/openaiCompatible.js';
import { completeAnthropic } from '../src/ai/providers/anthropic.js';
import type { AiMessage, AiToolSpec } from '../src/ai/types.js';

const tools: AiToolSpec[] = [
  {
    name: 'create_github_repo',
    description: 'یک مخزن می‌سازد',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

const conversation: AiMessage[] = [
  { role: 'system', content: 'تو یک ایجنت هستی' },
  { role: 'user', content: 'یک مخزن بساز' },
  { role: 'assistant', content: 'دارم می‌سازم', toolCalls: [{ id: 'call-1', name: 'create_github_repo', arguments: { name: 'demo' } }] },
  { role: 'tool', toolCallId: 'call-1', toolName: 'create_github_repo', content: 'ساخته شد' },
];

describe('function calling adapters', () => {
  it('maps tools and tool results to Gemini functionDeclarations/functionResponse', async () => {
    const mock = new FetchMock();
    mock.on(/generativelanguage\.googleapis\.com/, () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: 'بررسی کردم.' },
                { functionCall: { name: 'create_github_repo', args: { name: 'demo' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
      }),
    );

    const completion = await completeGemini({
      apiKey: 'AIzaFakeKey000000000000000000000',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-1.5-flash',
      request: { messages: conversation, tools },
      timeoutMs: 1000,
      fetchImpl: mock.fetch,
    });

    const body = mock.calls[0]!.body as {
      tools: Array<{ functionDeclarations: Array<{ name: string; parameters: unknown }> }>;
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(body.tools[0]!.functionDeclarations[0]!.name).toBe('create_github_repo');
    // The tool result is sent back as a user turn with a functionResponse.
    const last = body.contents.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.parts[0]).toMatchObject({ functionResponse: { name: 'create_github_repo' } });
    // The assistant tool call is a model turn.
    expect(body.contents.at(-2)!.parts.some((part) => 'functionCall' in part)).toBe(true);

    expect(completion.text).toBe('بررسی کردم.');
    expect(completion.toolCalls).toHaveLength(1);
    expect(completion.toolCalls![0]).toMatchObject({ name: 'create_github_repo', arguments: { name: 'demo' } });
    expect(completion.toolCalls![0]!.id).toBeTruthy();
  });

  it('sanitises the JSON Schema for Gemini and omits empty parameter objects', async () => {
    const mock = new FetchMock();
    mock.on(/generativelanguage\.googleapis\.com/, () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    );

    await completeGemini({
      apiKey: 'AIzaFakeKey000000000000000000000',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-1.5-flash',
      request: {
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          ...tools,
          { name: 'get_bot_capabilities', description: 'بدون آرگومان', parameters: { type: 'object', properties: {}, additionalProperties: false } },
        ],
      },
      timeoutMs: 1000,
      fetchImpl: mock.fetch,
    });

    const body = mock.calls[0]!.body as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    };
    const declarations = body.tools[0]!.functionDeclarations;
    // `additionalProperties` is not part of Gemini's Schema proto.
    expect(JSON.stringify(declarations)).not.toContain('additionalProperties');
    const noArgs = declarations.find((declaration) => declaration.name === 'get_bot_capabilities')!;
    expect(noArgs).not.toHaveProperty('parameters');
    expect(toGeminiSchema({ type: 'object', properties: { a: { type: 'string', title: 'A' } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
  });

  it('maps tools to OpenAI tool_calls/tool messages', async () => {
    const mock = new FetchMock();
    mock.on(/api\.groq\.com/, () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'call-9', type: 'function', function: { name: 'create_github_repo', arguments: '{"name":"demo"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 9 },
      }),
    );

    const completion = await completeOpenAiCompatible({
      provider: 'groq',
      apiKey: 'gsk_fake_key_for_tests_000000000',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama-3.1-70b',
      request: { messages: conversation, tools },
      timeoutMs: 1000,
      fetchImpl: mock.fetch,
    });

    const body = mock.calls[0]!.body as {
      tools: Array<{ type: string; function: { name: string } }>;
      messages: Array<Record<string, unknown>>;
    };
    expect(body.tools[0]!.function.name).toBe('create_github_repo');
    const assistant = body.messages.find((message) => message.role === 'assistant' && message.tool_calls);
    expect(assistant).toBeDefined();
    expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'ساخته شد' });

    expect(completion.toolCalls![0]).toMatchObject({ id: 'call-9', name: 'create_github_repo', arguments: { name: 'demo' } });
  });

  it('maps tools to Anthropic tool_use/tool_result blocks', async () => {
    const mock = new FetchMock();
    mock.on(/api\.anthropic\.com/, () =>
      jsonResponse({
        content: [
          { type: 'text', text: 'انجام شد' },
          { type: 'tool_use', id: 'tu-1', name: 'create_github_repo', input: { name: 'demo' } },
        ],
        usage: { input_tokens: 30, output_tokens: 12 },
        stop_reason: 'tool_use',
      }),
    );

    const completion = await completeAnthropic({
      apiKey: 'sk-ant-fake-key-for-tests-000000000',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-3-5-sonnet',
      request: { messages: conversation, tools },
      timeoutMs: 1000,
      fetchImpl: mock.fetch,
    });

    const body = mock.calls[0]!.body as {
      tools: Array<{ name: string; input_schema: unknown }>;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.tools[0]!.name).toBe('create_github_repo');
    const toolResult = JSON.stringify(body.messages.at(-1));
    expect(toolResult).toContain('tool_result');
    expect(toolResult).toContain('call-1');

    expect(completion.text).toBe('انجام شد');
    expect(completion.toolCalls![0]).toMatchObject({ id: 'tu-1', name: 'create_github_repo' });
  });

  it('recovers from malformed tool arguments instead of crashing', async () => {
    const mock = new FetchMock();
    mock.on(/api\.groq\.com/, () =>
      jsonResponse({
        choices: [
          { message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{not json' } }] } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const completion = await completeOpenAiCompatible({
      provider: 'groq',
      apiKey: 'gsk_fake_key_for_tests_000000000',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'llama',
      request: { messages: [{ role: 'user', content: 'x' }], tools },
      timeoutMs: 1000,
      fetchImpl: mock.fetch,
    });

    expect(completion.toolCalls![0]!.arguments).toHaveProperty('__raw');
  });
});

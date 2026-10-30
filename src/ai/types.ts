/** A single JSON-Schema-described tool the model may call. */
export interface AiToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object (type: "object"). */
  parameters: Record<string, unknown>;
}

/** A tool invocation requested by the model. */
export interface AiToolCall {
  /** Stable id used to correlate the call with its result. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * One turn of a conversation.
 *
 * `tool` messages carry the result of an `assistant` message that requested a
 * tool call, so the model can see what happened before it answers.
 */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant only: the tool calls requested in this turn. */
  toolCalls?: AiToolCall[];
  /** Tool only: which call this result belongs to. */
  toolCallId?: string;
  /** Tool only: the tool name (Gemini needs it, OpenAI needs the id). */
  toolName?: string;
  /** Tool only: the result is an error / the capability is unavailable. */
  toolError?: boolean;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Hard deadline - a Worker invocation must never exceed its budget. */
  timeoutMs?: number;
  jsonMode?: boolean;
  /** When set, the model may answer with text and/or tool calls. */
  tools?: AiToolSpec[];
}

export interface AiCompletion {
  text: string;
  /** Empty/undefined when the model answered with plain text. */
  toolCalls?: AiToolCall[];
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
  finishReason?: string;
}

export interface ProviderHealth {
  ok: boolean;
  status: string;
  latencyMs: number;
  error?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProviderDefinition {
  name: string;
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  models?: string[];
  freeTier: boolean;
  priority: number;
  dailyLimit: number;
  monthlyLimit: number;
  capabilities: string[];
  /** Where the env-var key lives; providers without a key are simply skipped. */
  envKey: keyof ProviderKeyEnv;
  /** Free-plan price is 0; paid providers carry an indicative USD/1M price. */
  usdPerMillionTokens?: { input: number; output: number };
}

export interface ProviderKeyEnv {
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export class NoProviderAvailableError extends Error {
  constructor(public readonly reasons: Array<{ provider: string; reason: string }>) {
    super('no provider available: ' + reasons.map((r) => `${r.provider}=${r.reason}`).join(', '));
    this.name = 'NoProviderAvailableError';
  }
}

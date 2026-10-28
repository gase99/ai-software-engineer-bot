export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Hard deadline - a Worker invocation must never exceed its budget. */
  timeoutMs?: number;
  jsonMode?: boolean;
}

export interface AiCompletion {
  text: string;
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

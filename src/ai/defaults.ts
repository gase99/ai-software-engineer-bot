import type { ProviderDefinition } from './types.js';

/**
 * Provider catalogue, ordered by "how free is it".
 * Anthropic/OpenAI are listed last and stay inactive unless the owner supplies
 * a key AND activates them explicitly (never an automatic upgrade to a paid
 * model - see docs/security.md).
 */
export const PROVIDER_CATALOG: ProviderDefinition[] = [
  {
    name: 'gemini',
    displayName: 'Google Gemini (free tier)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'],
    freeTier: true,
    priority: 10,
    dailyLimit: 500_000,
    monthlyLimit: 10_000_000,
    capabilities: ['chat', 'code', 'vision', 'long_context'],
    envKey: 'GEMINI_API_KEY',
  },
  {
    name: 'groq',
    displayName: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-70b-versatile',
    models: ['llama-3.1-70b-versatile', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    freeTier: true,
    priority: 20,
    dailyLimit: 500_000,
    monthlyLimit: 10_000_000,
    capabilities: ['chat', 'code'],
    envKey: 'GROQ_API_KEY',
  },
  {
    name: 'openrouter',
    displayName: 'OpenRouter (models tagged :free)',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct:free',
    models: ['meta-llama/llama-3.1-8b-instruct:free', 'google/gemma-2-9b-it:free', 'mistralai/mistral-7b-instruct:free'],
    freeTier: true,
    priority: 30,
    dailyLimit: 300_000,
    monthlyLimit: 6_000_000,
    capabilities: ['chat', 'code'],
    envKey: 'OPENROUTER_API_KEY',
  },
  {
    name: 'deepseek',
    displayName: 'DeepSeek (limited free credits)',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-coder'],
    freeTier: true,
    priority: 40,
    dailyLimit: 200_000,
    monthlyLimit: 4_000_000,
    capabilities: ['chat', 'code'],
    envKey: 'DEEPSEEK_API_KEY',
  },
  {
    name: 'openai',
    displayName: 'OpenAI (paid - opt-in only)',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    freeTier: false,
    priority: 90,
    dailyLimit: 100_000,
    monthlyLimit: 2_000_000,
    capabilities: ['chat', 'code', 'vision'],
    envKey: 'OPENAI_API_KEY',
    usdPerMillionTokens: { input: 0.15, output: 0.6 },
  },
  {
    name: 'anthropic',
    displayName: 'Anthropic (paid - opt-in only)',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-3-7-sonnet-latest'],
    freeTier: false,
    priority: 95,
    dailyLimit: 100_000,
    monthlyLimit: 2_000_000,
    capabilities: ['chat', 'code', 'long_context'],
    envKey: 'ANTHROPIC_API_KEY',
    usdPerMillionTokens: { input: 0.8, output: 4 },
  },
];

export function catalogEntry(name: string): ProviderDefinition | undefined {
  return PROVIDER_CATALOG.find((p) => p.name === name);
}

/**
 * Secret redaction.
 *
 * Two layers:
 *  1. Pattern based (Telegram token, GitHub PAT/App key, Gemini/Groq/OpenAI keys, PEM blocks)
 *  2. Value based - any secret the runtime learns about is registered here and
 *     every occurrence is masked before it can reach a log, a Telegram message
 *     or an AI prompt.
 */

const registered = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) registered.add(value);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED:TELEGRAM_TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:GITHUB_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED:GEMINI_KEY]'],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, '[REDACTED:GROQ_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:API_KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:ANTHROPIC_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]'],
];

export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  for (const secret of registered) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED:SECRET]');
  }
  // Query-string style leak: ?key=... &token=...
  out = out.replace(/([?&](?:key|token|api_key|apikey|access_token|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
  return out;
}

export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactObject(v);
    return out as T;
  }
  return value;
}

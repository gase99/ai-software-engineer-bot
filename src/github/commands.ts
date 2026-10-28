/**
 * Command allow-list.
 *
 * Hard rule from the spec: no command produced by a model is ever executed
 * directly. Every command must match this allow-list, contain no shell
 * metacharacters and pass through the same validator in the Worker (before
 * dispatch) and inside the Actions workflow (before execution).
 */

export const DEFAULT_ALLOWLIST = [
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run build',
  'npm run typecheck',
  'npm ci',
  'pytest',
  'pytest -q',
  'python -m pytest',
  'cargo test',
  'go test ./...',
  'mvn -q test',
  'yarn test',
  'pnpm test',
];

const DANGEROUS = /[;&|`$><\n\r(){}[\]]/;

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWLIST];
  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_ALLOWLIST];
}

export interface CommandCheck {
  allowed: boolean;
  command: string;
  reason?: string;
}

export function isCommandAllowed(command: string, allowlist: string[] = DEFAULT_ALLOWLIST): CommandCheck {
  const normalized = command.trim().replace(/\s+/g, ' ');
  if (!normalized) return { allowed: false, command: normalized, reason: 'دستور خالی است' };
  if (normalized.length > 200) return { allowed: false, command: normalized, reason: 'دستور بیش از حد طولانی است' };
  if (DANGEROUS.test(normalized)) {
    return { allowed: false, command: normalized, reason: 'دستور شامل کاراکترهای خطرناک پوسته است' };
  }
  const allowed = allowlist.some((entry) => {
    const candidate = entry.trim().replace(/\s+/g, ' ');
    if (normalized === candidate) return true;
    // allow extra safe flags/args for a known prefix command
    return normalized.startsWith(`${candidate} `) && !normalized.includes('..');
  });
  if (!allowed) return { allowed: false, command: normalized, reason: 'دستور در لیست مجاز نیست' };
  return { allowed: true, command: normalized };
}

/** Same rules, expressed as a shell snippet for the workflow runner. */
export function buildCommandScript(commands: string[], allowlist: string[]): { script: string; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const command of commands) {
    const check = isCommandAllowed(command, allowlist);
    if (check.allowed) accepted.push(check.command);
    else rejected.push(`${command} (${check.reason ?? 'نامجاز'})`);
  }
  return { script: accepted.join('\n'), rejected };
}

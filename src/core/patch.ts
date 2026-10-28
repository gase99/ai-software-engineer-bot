export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules', '.github', '..', '.']);
const SECRET_LOOKING = /(\.env(\.|$)|secret|credential|\.pem$|\.p8$|\.key$|id_rsa)/i;

/**
 * Path guard: a model must never be able to write outside the repository tree
 * or touch secret/CI files.
 */
export function validateRepoPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) throw new PatchError('مسیر فایل خالی است');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new PatchError(`مسیر مطلق مجاز نیست: ${path}`);
  const segments = normalized.split('/').filter(Boolean);
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) throw new PatchError(`مسیر مجاز نیست: ${path}`);
  }
  if (SECRET_LOOKING.test(normalized)) throw new PatchError(`تغییر فایل‌های حساس مجاز نیست: ${path}`);
  if (normalized.length > 200) throw new PatchError('مسیر فایل بیش از حد طولانی است');
  return segments.join('/');
}

/**
 * Apply a unified diff (--- a/file / +++ b/file / @@ -a,b +c,d @@) to the
 * original file content. Used when the model returns a diff instead of the
 * full file. Throws on any mismatch - a failed patch is reported, never
 * force-applied.
 */
export function applyUnifiedDiff(original: string, diff: string): string {
  const originalLines = original.split('\n');
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const result: string[] = [];
  let cursor = 0;
  let i = 0;

  while (i < lines.length && !lines[i]!.startsWith('@@')) i++;
  if (i >= lines.length) throw new PatchError('diff بدون هانک معتبر است');

  while (i < lines.length) {
    const header = lines[i]!;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (!match) throw new PatchError(`سربرگ هانک نامعتبر: ${header}`);
    const start = Math.max(0, Number(match[1]) - 1);

    if (start > cursor) {
      if (start > originalLines.length) throw new PatchError('هانک خارج از محدوده فایل است');
      while (cursor < start) result.push(originalLines[cursor++]!);
    }

    i++;
    while (i < lines.length && !lines[i]!.startsWith('@@')) {
      const line = lines[i]!;
      i++;
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      if (line === '') {
        if (originalLines[cursor] !== '') throw new PatchError(`زمینه خالی در خط ${cursor + 1} مطابقت ندارد`);
        result.push('');
        cursor++;
        continue;
      }
      const op = line[0];
      const text = line.slice(1);
      if (op === ' ') {
        if (originalLines[cursor] !== text) {
          const offset = findContextOffset(originalLines, lines, i - 1, cursor);
          if (offset === null) throw new PatchError(`زمینه در خط ${cursor + 1} مطابقت ندارد`);
          cursor = offset;
          continue;
        }
        result.push(text);
        cursor++;
      } else if (op === '-') {
        if (originalLines[cursor] !== text) throw new PatchError(`خط حذفی در خط ${cursor + 1} مطابقت ندارد`);
        cursor++;
      } else if (op === '+') {
        result.push(text);
      } else {
        throw new PatchError(`نویسه نامعتبر در هانک: ${op}`);
      }
    }
  }

  while (cursor < originalLines.length) result.push(originalLines[cursor++]!);
  return result.join('\n');
}

/** Small fuzzy recovery: look for the hunk context within ±30 lines. */
function findContextOffset(originalLines: string[], hunkLines: string[], hunkIndex: number, cursor: number): number | null {
  const context: string[] = [];
  for (let k = hunkIndex; k < hunkLines.length && !hunkLines[k]!.startsWith('@@'); k++) {
    const line = hunkLines[k]!;
    if (line.startsWith(' ') || line.startsWith('-')) context.push(line.slice(1));
  }
  if (!context.length) return null;
  const needle = context[0]!;
  for (let offset = Math.max(0, cursor - 30); offset <= Math.min(originalLines.length - 1, cursor + 30); offset++) {
    if (originalLines[offset] === needle) {
      let matches = true;
      for (let c = 0; c < context.length && offset + c < originalLines.length; c++) {
        if (originalLines[offset + c] !== context[c]) {
          matches = false;
          break;
        }
      }
      if (matches) return offset;
    }
  }
  return null;
}

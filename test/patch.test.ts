import { describe, expect, it } from 'vitest';
import { applyUnifiedDiff, validateRepoPath, PatchError } from '../src/core/patch.js';

describe('patch application and path safety', () => {
  it('applies a clean unified diff', () => {
    const original = 'line1\nline2\nline3\n';
    const diff = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,4 @@', ' line1', '+inserted', ' line2', ' line3'].join('\n');
    expect(applyUnifiedDiff(original, diff)).toBe('line1\ninserted\nline2\nline3\n');
  });

  it('removes lines', () => {
    const original = 'a\nb\nc\n';
    const diff = ['@@ -1,3 +1,2 @@', ' a', '-b', ' c'].join('\n');
    expect(applyUnifiedDiff(original, diff)).toBe('a\nc\n');
  });

  it('fails loudly instead of corrupting a file on mismatch', () => {
    const original = 'a\nb\nc\n';
    const diff = ['@@ -1,3 +1,3 @@', ' a', '-x', ' c'].join('\n');
    expect(() => applyUnifiedDiff(original, diff)).toThrow(PatchError);
  });

  it('recovers when the hunk is offset in the file', () => {
    const original = 'header\nheader2\na\nb\nc\n';
    const diff = ['@@ -1,3 +1,4 @@', ' a', ' b', '+c2', ' c'].join('\n');
    expect(applyUnifiedDiff(original, diff)).toContain('c2');
  });

  it('rejects paths outside the repo, secret files and CI files', () => {
    expect(validateRepoPath('src/app.ts')).toBe('src/app.ts');
    for (const bad of ['../secrets.txt', '/etc/passwd', '.env', 'config/.env.production', '.github/workflows/ai-exec.yml', 'node_modules/x/y.ts', 'a/../../b.ts']) {
      expect(() => validateRepoPath(bad), bad).toThrow(PatchError);
    }
  });
});

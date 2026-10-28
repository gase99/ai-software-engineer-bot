import type { TreeEntry } from '../github/client.js';
import { estimateTokens } from '../util/text.js';
import { wrapUntrusted } from '../security/promptGuard.js';

export interface RepoSnapshot {
  owner: string;
  repo: string;
  branch: string;
  tree: TreeEntry[];
  files: Record<string, string>;
  truncated: boolean;
}

export interface StackInfo {
  language: string;
  framework: string;
  packageManager: string;
  testCommand: string;
  manifest: string | null;
}

const FRAMEWORK_HINTS: Array<{ file: string; framework: string }> = [
  { file: 'next.config.js', framework: 'Next.js' },
  { file: 'next.config.mjs', framework: 'Next.js' },
  { file: 'wrangler.toml', framework: 'Cloudflare Workers' },
  { file: 'vite.config.ts', framework: 'Vite' },
  { file: 'svelte.config.js', framework: 'SvelteKit' },
  { file: 'nuxt.config.ts', framework: 'Nuxt' },
  { file: 'angular.json', framework: 'Angular' },
  { file: 'manage.py', framework: 'Django' },
  { file: 'fastapi', framework: 'FastAPI' },
];

export function detectStack(tree: TreeEntry[], files: Record<string, string>): StackInfo {
  const paths = new Set(tree.map((entry) => entry.path));
  const has = (name: string) => paths.has(name);

  if (has('package.json')) {
    let framework = 'Node.js';
    for (const hint of FRAMEWORK_HINTS) if (has(hint.file)) framework = hint.framework;
    if (framework === 'Node.js') {
      const pkg = files['package.json'] ?? '';
      for (const [dep, label] of Object.entries({
        '"react"': 'React',
        '"vue"': 'Vue',
        '"hono"': 'Hono',
        '"express"': 'Express',
        '"aiogram"': 'aiogram',
      })) {
        if (pkg.includes(dep)) framework = label;
      }
    }
    const packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    return { language: 'TypeScript/JavaScript', framework, packageManager, testCommand: `${packageManager} test`, manifest: 'package.json' };
  }
  if (has('pyproject.toml') || has('requirements.txt')) {
    const manifest = has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt';
    const content = files[manifest] ?? '';
    let framework = 'Python';
    if (content.includes('fastapi')) framework = 'FastAPI';
    else if (content.includes('django')) framework = 'Django';
    else if (content.includes('flask')) framework = 'Flask';
    else if (content.includes('aiogram')) framework = 'aiogram';
    return { language: 'Python', framework, packageManager: 'pip', testCommand: 'pytest', manifest };
  }
  if (has('Cargo.toml')) return { language: 'Rust', framework: 'Cargo', packageManager: 'cargo', testCommand: 'cargo test', manifest: 'Cargo.toml' };
  if (has('go.mod')) return { language: 'Go', framework: 'Go modules', packageManager: 'go', testCommand: 'go test ./...', manifest: 'go.mod' };
  if (has('pom.xml')) return { language: 'Java', framework: 'Maven', packageManager: 'mvn', testCommand: 'mvn -q test', manifest: 'pom.xml' };
  return { language: 'نامشخص', framework: 'نامشخص', packageManager: 'نامشخص', testCommand: 'نامشخص', manifest: null };
}

const IGNORED_PREFIXES = [
  'node_modules/', 'dist/', 'build/', '.git/', 'coverage/', '.next/', 'venv/', '.venv/', '__pycache__/', 'target/', '.wrangler/',
];
const IGNORED_SUFFIXES = ['.lock', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.pdf', '.zip', '.min.js', '.map'];

export function interestingFiles(tree: TreeEntry[]): TreeEntry[] {
  return tree.filter((entry) => {
    if (entry.type !== 'blob') return false;
    if (IGNORED_PREFIXES.some((prefix) => entry.path.startsWith(prefix))) return false;
    if (IGNORED_SUFFIXES.some((suffix) => entry.path.endsWith(suffix))) return false;
    const depth = entry.path.split('/').length;
    return depth <= 4 && (entry.size ?? 0) < 200_000;
  });
}

/** Rank files by how likely they are to matter for the request. */
export function rankFiles(tree: TreeEntry[], keywords: string[]): TreeEntry[] {
  const normalizedKeywords = keywords.map((k) => k.toLowerCase()).filter((k) => k.length > 2);
  return interestingFiles(tree)
    .map((entry) => {
      const path = entry.path.toLowerCase();
      let score = 0;
      if (/readme/i.test(path)) score += 5;
      if (/(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|wrangler\.toml|requirements\.txt)/.test(path)) score += 4;
      if (/(test|spec)/.test(path)) score += 1;
      for (const keyword of normalizedKeywords) if (path.includes(keyword)) score += 6;
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry);
}

export interface BuiltContext {
  text: string;
  includedFiles: string[];
  estimatedTokens: number;
  truncated: boolean;
}

/**
 * Build the analysis context inside a token budget. Repository content is
 * always fenced as untrusted data so it cannot rewrite the instructions.
 */
export function buildContext(snapshot: RepoSnapshot, requestText: string, budgetTokens = 24_000): BuiltContext {
  const stack = detectStack(snapshot.tree, snapshot.files);
  const keywords = requestText.split(/\s+/).slice(0, 12);
  const ranked = rankFiles(snapshot.tree, keywords);

  const header = [
    `repository: ${snapshot.owner}/${snapshot.repo}`,
    `branch: ${snapshot.branch}`,
    `detected language: ${stack.language}`,
    `detected framework: ${stack.framework}`,
    `suggested test command: ${stack.testCommand}`,
    `files in tree: ${snapshot.tree.length}`,
  ].join('\n');

  let used = estimateTokens(header);
  const includedFiles: string[] = [];
  const blocks: string[] = [header];

  for (const entry of ranked) {
    const content = snapshot.files[entry.path];
    if (content === undefined) continue;
    const block = wrapUntrusted(`file:${entry.path}`, content, 6000);
    const cost = estimateTokens(block);
    if (used + cost > budgetTokens) break;
    used += cost;
    includedFiles.push(entry.path);
    blocks.push(block);
  }

  const treePreview = ranked
    .slice(0, 120)
    .map((entry) => entry.path)
    .join('\n');
  blocks.push(wrapUntrusted('tree', treePreview, 4000));

  return {
    text: blocks.join('\n\n'),
    includedFiles,
    estimatedTokens: used,
    truncated: includedFiles.length < ranked.length,
  };
}

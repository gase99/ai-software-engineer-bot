import type { GithubClient } from '../github/client.js';
import { interestingFiles, rankFiles, type RepoSnapshot } from './context.js';

export interface SnapshotOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  keywords?: string[];
}

/**
 * Read a repository into memory: the tree plus the content of the most
 * relevant files. Read-only - the bot never clones the repo in the Worker.
 */
export async function takeSnapshot(
  client: GithubClient,
  owner: string,
  repo: string,
  branch: string,
  options: SnapshotOptions = {},
): Promise<RepoSnapshot> {
  const maxFiles = options.maxFiles ?? 12;
  const maxFileBytes = options.maxFileBytes ?? 200_000;
  const tree = await client.getTree(owner, repo, branch);
  const ranked = (options.keywords?.length ? rankFiles(tree, options.keywords) : interestingFiles(tree)).slice(0, maxFiles);

  const files: Record<string, string> = {};
  for (const entry of ranked) {
    try {
      const file = await client.getFile(owner, repo, entry.path, branch);
      files[entry.path] = file.size > maxFileBytes ? file.content.slice(0, maxFileBytes) : file.content;
    } catch {
      // A file we cannot read (binary, submodule, permission) is skipped and
      // reported as a limitation rather than silently ignored.
      files[entry.path] = '';
    }
  }

  return { owner, repo, branch, tree, files, truncated: ranked.length < tree.length };
}

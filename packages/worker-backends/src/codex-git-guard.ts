/**
 * A check that a codex session left the repository's git hooks and config
 * alone. The sandbox keeps them read-only (codex-args.ts, gitWritableDirs);
 * this is the second layer. swarm's own git commands run outside the
 * sandbox, some with GitHub credentials, and would run a hook an agent
 * planted, so a change is put back and the session fails.
 */

import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitDirectories } from "./codex-args.js";

/** A watched file as it was: its contents and permission bits (contents null for a directory or something unreadable). */
interface Entry {
  content: Buffer | null;
  mode: number;
}
type Snapshot = Map<string, Entry>;

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** A repository's config, hooks and attributes, and each submodule's config and hooks. */
function watchedFiles(common: string, gitDir: string): string[] {
  const files = [
    join(common, "config"),
    join(common, "config.worktree"),
    join(gitDir, "config.worktree"),
    join(common, "info", "attributes"),
    ...listDir(join(common, "hooks")),
  ];
  for (const module of listDir(join(common, "modules"))) {
    files.push(join(module, "config"), ...listDir(join(module, "hooks")));
  }
  return [...new Set(files)];
}

function take(files: string[]): Snapshot {
  const snap: Snapshot = new Map();
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const stat = lstatSync(file);
      snap.set(file, { content: stat.isFile() ? readFileSync(file) : null, mode: stat.mode & 0o7777 });
    } catch {
      snap.set(file, { content: null, mode: 0 });
    }
  }
  return snap;
}

function same(a: Entry, b: Entry): boolean {
  if (a.mode !== b.mode) return false;
  if (a.content === null || b.content === null) return a.content === b.content;
  return a.content.equals(b.content);
}

/** Put a file back as it was, contents and permission bits. */
function put(file: string, was: Entry): void {
  if (was.content === null) return;
  writeFileSync(file, was.content);
  chmodSync(file, was.mode);
}

export interface GitGuard {
  /** Files that changed since the guard was taken; each is put back as it was. */
  restore(): string[];
}

/** Remember the repository's hooks and config, or null outside a repository. */
export function guardGitConfig(cwd: string): GitGuard | null {
  const dirs = gitDirectories(cwd);
  if (!dirs) return null;
  const before = take(watchedFiles(dirs.common, dirs.gitDir));
  return {
    restore(): string[] {
      const after = take(watchedFiles(dirs.common, dirs.gitDir));
      const changed: string[] = [];
      for (const [file, now] of after) {
        const was = before.get(file);
        if (was === undefined) {
          changed.push(file);
          rmSync(file, { recursive: true, force: true });
        } else if (!same(was, now)) {
          changed.push(file);
          put(file, was);
        }
      }
      for (const [file, was] of before) {
        if (!after.has(file)) {
          changed.push(file);
          put(file, was);
        }
      }
      return changed;
    },
  };
}

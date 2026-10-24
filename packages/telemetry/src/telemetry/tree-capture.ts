/**
 * Capture directory tree snapshots before and after a swarm run.
 * Uses a simple recursive directory listing (no external dependencies).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Capture a directory tree as a text string, similar to the `tree` command.
 * Respects .gitignore-like patterns for common exclusions.
 */
export async function captureTree(
  rootDir: string,
  maxDepth: number = 6,
): Promise<string> {
  const EXCLUDED = new Set([
    "node_modules", ".git", ".DS_Store", "dist",
    ".build", "build", "Pods", "DerivedData",
  ]);

  const lines: string[] = [rootDir];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then files, alphabetical within each group
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    // Filter exclusions
    entries = entries.filter((e) => !EXCLUDED.has(e.name));

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
      const childPrefix = isLast ? "    " : "\u2502   ";

      lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`);

      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), prefix + childPrefix, depth + 1);
      }
    }
  }

  await walk(rootDir, "", 0);
  return lines.join("\n") + "\n";
}

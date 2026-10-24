/**
 * Parse structured checks from definition-of-done markdown files.
 */

import type { FunctionalCheck } from "@mnmal-ai/swarm-types";

export type { FunctionalCheck };

/**
 * Extract functional_checks from a definition-of-done markdown file.
 * Looks for a fenced code block with language `json:functional_checks`.
 */
export function parseFunctionalChecks(markdown: string): FunctionalCheck[] {
  const match = markdown.match(/```json:functional_checks\n([\s\S]*?)```/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: any): item is FunctionalCheck =>
        typeof item.description === "string" &&
        typeof item.command === "string",
    );
  } catch {
    return [];
  }
}

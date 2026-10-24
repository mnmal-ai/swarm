/**
 * Items a reviewer passed a task with but left for a person: an on-device
 * check, a credential only a person holds, a judgment call. Swarm surfaces
 * them on the goal's pull request, on its source item and in the run summary,
 * so a deferral is never invisible.
 */

/** What reviewers left for a person on one task. */
export interface LeftForPersonGroup {
  /** The task's title, or its description when it has none. */
  task: string;
  /** One line per item. */
  items: string[];
}

/** An item's identity for de-duplication: case and spacing don't count. */
function itemKey(item: string): string {
  return item.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * `groups` with `items` added under `task`: blank items dropped, and an item
 * already listed anywhere in `groups` (under any task) not listed again. A
 * task with nothing new adds no group. Returns a new array; `groups` is not
 * changed.
 */
export function addLeftForPerson(groups: readonly LeftForPersonGroup[], task: string, items: readonly string[]): LeftForPersonGroup[] {
  const seen = new Set(groups.flatMap((g) => g.items.map(itemKey)));
  const fresh: string[] = [];
  for (const raw of items) {
    const item = raw.replace(/\s+/g, " ").trim();
    const key = itemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(item);
  }
  if (fresh.length === 0) return [...groups];
  const existing = groups.findIndex((g) => g.task === task);
  if (existing === -1) return [...groups, { task, items: fresh }];
  return groups.map((g, i) => (i === existing ? { task: g.task, items: [...g.items, ...fresh] } : g));
}

/** How many items `groups` hold. */
export function countLeftForPerson(groups: readonly LeftForPersonGroup[] | undefined): number {
  return (groups ?? []).reduce((n, g) => n + g.items.length, 0);
}

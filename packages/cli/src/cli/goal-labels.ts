/**
 * Labels for the live dashboard's goal badges (see goal-label.ts in
 * @mnmal-ai/swarm-types). Each goal gets, in order: the label its goals.json
 * entry sets; the label a model picked, when the project names one
 * (`taskBackendConfig.labels.model`); the ticket's id from its URL. A goal
 * with none of these keeps showing its goal id.
 *
 * Model labels are cached in a small file under the project's .swarm state,
 * keyed by source, goal id and a hash of the title, so a ticket keeps its
 * label from run to run and only a new or retitled ticket costs a call. The
 * calls run a few at a time within a time budget; a failure, a timeout or an
 * unusable reply keeps the URL id and is asked again next run.
 *
 * The labels are returned, not written onto the goals: goals.json is written
 * back from those objects, and must keep only the labels people wrote.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { labelFromUrl, normalizeGoalLabel, sanitizeModelLabel, validateLabelsConfig, type Goal, type ProjectConfig } from "@mnmal-ai/swarm-types";
import type { LabelWriter } from "@mnmal-ai/swarm-worker-backends";

/** Refuse to start with a malformed `taskBackendConfig.labels`. */
export function assertValidLabelsConfig(projectConfig: ProjectConfig, configPath: string): void {
  const errors = validateLabelsConfig(projectConfig.taskBackendConfig?.labels);
  if (errors.length === 0) return;
  throw new Error(`Invalid taskBackendConfig.labels in ${configPath}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
}

export interface LabelGoalsOptions {
  /** The task source's name ("trello", "github", "local"); part of the cache key. */
  source: string;
  /** Present only when the project names a model. */
  writer?: LabelWriter;
  /** The model-label cache file. */
  cachePath: string;
  log: (line: string) => void;
  /** Model calls at once. Default 4. */
  concurrency?: number;
  /** How long a run waits for model labels in all. Default 30 s. */
  budgetMs?: number;
  /** Cache entries kept, newest first. Default 2000. */
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry {
  titleHash: string;
  label: string;
  model: string;
  at: number;
}

interface LabelCache {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const titleHash = (title: string) => createHash("sha256").update(title).digest("hex").slice(0, 16);

async function readCache(path: string): Promise<LabelCache> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<LabelCache>;
    const entries: Record<string, CacheEntry> = {};
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      for (const [key, entry] of Object.entries(parsed.entries)) {
        // A label that wouldn't pass as a fresh reply is dropped and asked for again.
        if (typeof entry?.titleHash === "string" && typeof entry.label === "string" && sanitizeModelLabel(entry.label) === entry.label) {
          entries[key] = { titleHash: entry.titleHash, label: entry.label, model: String(entry.model ?? ""), at: Number(entry.at) || 0 };
        }
      }
    }
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

/** Add this run's new labels to the cache file as it is now, so a run alongside this one keeps its own. */
async function saveLabels(path: string, fresh: Record<string, CacheEntry>, maxEntries: number): Promise<void> {
  const kept = Object.entries({ ...(await readCache(path)).entries, ...fresh })
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, maxEntries);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, entries: Object.fromEntries(kept) }, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

/** Resolves to `promise`'s value, or rejects once `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("out of time"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("out of time"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Each goal's badge label, by goal id. Goals with no label are absent. */
export async function labelGoals(goals: Goal[], opts: LabelGoalsOptions): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const unlabelled: Goal[] = [];
  for (const goal of goals) {
    const own = normalizeGoalLabel(goal.label);
    if (own) {
      labels.set(goal.id, own);
      continue;
    }
    if (goal.label !== undefined) {
      opts.log(`labels: goal ${goal.id} has a label in goals.json that isn't one line of at most 32 characters; ignoring it`);
    }
    unlabelled.push(goal);
  }

  const writer = opts.writer;
  if (writer && unlabelled.length > 0) {
    const now = opts.now ?? Date.now;
    const cache = await readCache(opts.cachePath);
    const misses: Array<{ goal: Goal; key: string; hash: string }> = [];
    let cached = 0;
    for (const goal of unlabelled) {
      const key = `${opts.source}:${goal.id}`;
      const hash = titleHash(goal.description);
      const entry = cache.entries[key];
      if (entry && entry.titleHash === hash) {
        labels.set(goal.id, entry.label);
        cached++;
      } else {
        misses.push({ goal, key, hash });
      }
    }

    if (misses.length > 0) {
      // The budget stops new calls and ends those under way.
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(), opts.budgetMs ?? 30_000);
      const fresh: Record<string, CacheEntry> = {};
      let next = 0;
      const work = async () => {
        while (next < misses.length && !budget.signal.aborted) {
          const { goal, key, hash } = misses[next++]!;
          try {
            const reply = await untilAborted(writer.write({ title: goal.description, source: opts.source }, { signal: budget.signal }), budget.signal);
            const label = sanitizeModelLabel(reply);
            if (label === undefined) continue;
            labels.set(goal.id, label);
            fresh[key] = { titleHash: hash, label, model: writer.model, at: now() };
          } catch {
            // Keeps the URL id below; asked again next run.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, misses.length) }, work));
      clearTimeout(timer);
      const picked = Object.keys(fresh).length;
      opts.log(`labels: ${picked} picked by ${writer.model}, ${cached} from cache, ${misses.length - picked} kept the ticket id`);
      if (picked > 0) {
        await saveLabels(opts.cachePath, fresh, opts.maxEntries ?? 2000).catch((err: unknown) => {
          opts.log(`labels: couldn't save the label cache (${err instanceof Error ? err.message : String(err)}); they'll be asked for again`);
        });
      }
    }
  }

  for (const goal of unlabelled) {
    if (labels.has(goal.id)) continue;
    const fromUrl = labelFromUrl(goal.url);
    if (fromUrl) labels.set(goal.id, fromUrl);
  }
  return labels;
}

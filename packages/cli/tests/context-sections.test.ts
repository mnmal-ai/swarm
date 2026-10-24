/**
 * swarm run's side of stage 1 of the context-sections spec: the project's
 * `context` block is checked at startup, and when sections are on, swarm
 * stores the swarm's markdown and the project's documents as sections before
 * each task, from that task's own checkout.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmbedderSettings, type SourceFile, type SyncOptions, type SyncReport } from "@mnmal-ai/swarm-substrate";
import {
  createSectionSync,
  describeDocumentReads,
  listProjectMarkdown,
  rankingEnv,
  resolveContextPull,
  resolveContextRules,
  resolveContextRanking,
  resolveContextSections,
  validateContextConfig,
} from "../src/cli/context-sections.js";
import { listSwarmMarkdown } from "../src/cli/seed.js";

describe("validateContextConfig", () => {
  it("accepts no block, an empty one and a full one", () => {
    expect(validateContextConfig(undefined)).toEqual([]);
    expect(validateContextConfig({})).toEqual([]);
    expect(validateContextConfig({ sections: { enabled: true, paths: ["docs/", "specs"] } })).toEqual([]);
    expect(validateContextConfig({ sections: { enabled: true, concurrency: 1 } })).toEqual([]);
    expect(validateContextConfig({ sections: { enabled: true, concurrency: 8 } })).toEqual([]);
  });

  it("takes a concurrency of 1 to 8 only", () => {
    for (const concurrency of [0, 9, 2.5, "4", -1]) {
      expect(validateContextConfig({ sections: { concurrency } }), String(concurrency)).toEqual([expect.stringContaining("context.sections.concurrency")]);
    }
  });

  it("names every problem", () => {
    expect(validateContextConfig("on")).toEqual([expect.stringContaining("context must be an object")]);
    expect(validateContextConfig({ sections: { enabled: "yes", paths: ["docs/", "", "/etc", "../up", 3], extra: 1 }, other: true })).toEqual([
      expect.stringContaining("context.sections.enabled"),
      expect.stringContaining("context.sections.paths"),
      expect.stringContaining("context.sections.extra is not a setting"),
      expect.stringContaining("context.other is not a setting"),
    ]);
  });
});

describe("validateContextConfig: context.pull", () => {
  const sections = { enabled: true };

  it("accepts pull with sections, and pull switched off without them", () => {
    expect(validateContextConfig({ sections, pull: { enabled: true } })).toEqual([]);
    expect(validateContextConfig({ sections, pull: { enabled: true, maxReadTokens: 500 } })).toEqual([]);
    expect(validateContextConfig({ sections, pull: { enabled: true, maxReadTokens: 100000 } })).toEqual([]);
    expect(validateContextConfig({ pull: { enabled: false } })).toEqual([]);
  });

  it("names a pull block that isn't an object", () => {
    expect(validateContextConfig({ sections, pull: true })).toEqual(['context.pull must be an object like { "enabled": true } (got true)']);
  });

  it("names a bad enabled, a bad maxReadTokens and an unknown key", () => {
    expect(validateContextConfig({ sections, pull: { enabled: "yes" } })).toEqual(['context.pull.enabled must be true or false (got "yes")']);
    for (const maxReadTokens of [499, 100001, 2.5, "4000", -1]) {
      expect(validateContextConfig({ sections, pull: { enabled: true, maxReadTokens } }), String(maxReadTokens)).toEqual([
        `context.pull.maxReadTokens must be a whole number from 500 to 100000 (got ${JSON.stringify(maxReadTokens)})`,
      ]);
    }
    expect(validateContextConfig({ sections, pull: { enabled: true, limit: 3 } })).toEqual(["context.pull.limit is not a setting (known: enabled, maxReadTokens)"]);
  });

  it("refuses pull without sections", () => {
    const needs = "context.pull needs context.sections.enabled: the index lists stored sections";
    expect(validateContextConfig({ pull: { enabled: true } })).toEqual([needs]);
    expect(validateContextConfig({ sections: { enabled: false }, pull: { enabled: true } })).toEqual([needs]);
  });
});

describe("resolveContextPull", () => {
  it("is on only with pull and sections both enabled, with a read limit of 4,000 tokens by default", () => {
    expect(resolveContextPull(undefined)).toBeNull();
    expect(resolveContextPull({ sections: { enabled: true } })).toBeNull();
    expect(resolveContextPull({ sections: { enabled: true }, pull: { enabled: false } })).toBeNull();
    expect(resolveContextPull({ pull: { enabled: true } })).toBeNull();
    expect(resolveContextPull({ sections: { enabled: true }, pull: { enabled: true } })).toEqual({ maxReadTokens: 4000 });
    expect(resolveContextPull({ sections: { enabled: true }, pull: { enabled: true, maxReadTokens: 12000 } })).toEqual({ maxReadTokens: 12000 });
  });
});

describe("validateContextConfig: context.rules", () => {
  it("accepts rules on their own, without sections or pull", () => {
    expect(validateContextConfig({ rules: { enabled: true } })).toEqual([]);
    expect(validateContextConfig({ rules: { enabled: true, maxTokens: 4000, relevant: 0, paths: ["domains/acme/conventions.md"] } })).toEqual([]);
  });

  it("names a bad enabled, maxTokens, relevant, path and unknown key", () => {
    const errors = validateContextConfig({ rules: { enabled: "yes", maxTokens: 50, relevant: 21, paths: ["../outside.md", "notes.txt"], ranking: true } });
    expect(errors).toEqual([
      'context.rules.enabled must be true or false (got "yes")',
      "context.rules.maxTokens must be a whole number from 200 to 100000 (got 50)",
      "context.rules.relevant must be a whole number from 0 to 20 (got 21)",
      'context.rules.paths must be markdown files inside the swarm folder, e.g. ["domains/acme/conventions.md"] (got ["../outside.md","notes.txt"])',
      "context.rules.ranking is not a setting (known: enabled, maxTokens, relevant, paths)",
    ]);
    expect(validateContextConfig({ rules: [] })).toEqual(['context.rules must be an object like { "enabled": true } (got [])']);
  });
});

describe("resolveContextRules", () => {
  it("is off unless rules.enabled is true, with a 2,000-token budget, 3 relevant rules and no extra files by default", () => {
    expect(resolveContextRules(undefined)).toBeNull();
    expect(resolveContextRules({ rules: { enabled: false } })).toBeNull();
    expect(resolveContextRules({ rules: { enabled: true } })).toEqual({ maxTokens: 2000, relevant: 3, paths: [] });
    expect(resolveContextRules({ rules: { enabled: true, maxTokens: 800, relevant: 1, paths: ["domains/acme/conventions.md"] } })).toEqual({
      maxTokens: 800,
      relevant: 1,
      paths: ["domains/acme/conventions.md"],
    });
  });
});

describe("describeDocumentReads", () => {
  it("says how a session read its indexed documents, and nothing when it read none", () => {
    expect(describeDocumentReads({ bounded: 5, refused: 1, whole: 0, ranges: [] })).toBe("5 section reads, 1 refused");
    expect(describeDocumentReads({ bounded: 1, refused: 0, whole: 2, ranges: [] })).toBe("1 section read, 0 refused, 2 whole");
    expect(describeDocumentReads({ bounded: 0, refused: 0, whole: 0, ranges: [] })).toBeNull();
  });
});

describe("resolveContextSections", () => {
  it("is off unless sections.enabled is true, and defaults paths to docs/", () => {
    expect(resolveContextSections(undefined)).toBeNull();
    expect(resolveContextSections({ sections: { enabled: false } })).toBeNull();
    expect(resolveContextSections({ sections: { enabled: true } })).toEqual({ paths: ["docs/"] });
    expect(resolveContextSections({ sections: { enabled: true, paths: ["specs"] } })).toEqual({ paths: ["specs"] });
    expect(resolveContextSections({ sections: { enabled: true, concurrency: 2 } })).toEqual({ paths: ["docs/"], concurrency: 2 });
  });
});

describe("listProjectMarkdown", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-sections-"));
    mkdirSync(join(dir, "docs", "specs"), { recursive: true });
    mkdirSync(join(dir, "docs", "node_modules", "x"), { recursive: true });
    mkdirSync(join(dir, "docs", ".hidden"), { recursive: true });
    writeFileSync(join(dir, "docs", "a.md"), "# A");
    writeFileSync(join(dir, "docs", "specs", "b.md"), "# B");
    writeFileSync(join(dir, "docs", "notes.txt"), "not markdown");
    writeFileSync(join(dir, "docs", "node_modules", "x", "c.md"), "# C");
    writeFileSync(join(dir, "docs", ".hidden", "d.md"), "# D");
    writeFileSync(join(dir, "README.md"), "# outside");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the markdown under the configured folders, by path relative to the checkout", async () => {
    const files = await listProjectMarkdown(dir, ["docs/"]);
    expect(files.map((f) => f.path)).toEqual(["docs/a.md", "docs/specs/b.md"]);
    expect(files[0].content).toBe("# A");
  });

  it("skips folders that don't exist and never reads outside the checkout", async () => {
    expect(await listProjectMarkdown(dir, ["missing/", "../"])).toEqual([]);
  });

  it("throws, rather than reading as empty, when a folder exists but can't be read", async () => {
    // An empty answer would make sync delete every stored document under it.
    chmodSync(join(dir, "docs", "specs"), 0o000);
    try {
      await expect(listProjectMarkdown(dir, ["docs/"])).rejects.toThrow();
    } finally {
      chmodSync(join(dir, "docs", "specs"), 0o755);
    }
  });
});

describe("createSectionSync", () => {
  it("syncs the swarm's markdown and the task checkout's documents together, one sync at a time", async () => {
    const calls: Array<{ files: SourceFile[]; opts: SyncOptions }> = [];
    let running = 0;
    let overlapped = false;
    const report: SyncReport = {
      documents: { created: 0, updated: 0, unchanged: 0, deleted: 0 },
      synopses: { model: 0, override: 0, fallback: 0, cached: 0 },
      errors: [],
    };
    const sync = createSectionSync({
      projectId: "acme",
      paths: ["docs/"],
      listSwarmFiles: async () => [{ path: "core/rules.md", content: "# Rules" }],
      listProjectFiles: async (cwd) => [{ path: `docs/${cwd}.md`, content: "# Doc" }],
      commitOf: async (cwd) => `commit-${cwd}`,
      syncDocuments: async (files, opts) => {
        running++;
        if (running > 1) overlapped = true;
        calls.push({ files, opts });
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return report;
      },
    });
    await Promise.all([sync("one"), sync("two")]);
    expect(overlapped).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0].files).toEqual([
      { path: "core/rules.md", source: "swarm", content: "# Rules" },
      { path: "docs/one.md", source: "project", content: "# Doc" },
    ]);
    expect(calls[0].opts).toMatchObject({ projectId: "acme", sources: ["swarm", "project"], commit: "commit-one" });
  });

  it("doesn't sync at all when the checkout's documents can't be listed", async () => {
    const logs: string[] = [];
    let synced = false;
    const sync = createSectionSync({
      projectId: "acme",
      paths: ["docs/"],
      listSwarmFiles: async () => [],
      listProjectFiles: async () => {
        throw new Error("EACCES: permission denied");
      },
      commitOf: async () => null,
      syncDocuments: async () => {
        synced = true;
        throw new Error("unreachable");
      },
      log: (m) => logs.push(m),
    });
    await sync("x");
    expect(synced).toBe(false);
    expect(logs.join("\n")).toContain("permission denied");
  });

  describe("saying what it's doing", () => {
    const EMPTY: SyncReport = {
      documents: { created: 0, updated: 0, unchanged: 0, deleted: 0 },
      synopses: { model: 0, override: 0, fallback: 0, cached: 0 },
      errors: [],
    };
    /** A clock the test moves, and a sync that plays back progress steps at given times. */
    type Step = { at: number; done: number; bytesDone: number };
    const setup = (opts: { total: number; bytesTotal: number; steps: Step[]; failures?: number; fallbacks?: number; endAt?: number }) => {
      let clock = 1_000_000;
      const logs: string[] = [];
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const sync = createSectionSync({
        projectId: "acme",
        paths: ["docs/"],
        listSwarmFiles: async () => [],
        listProjectFiles: async () => [],
        commitOf: async () => null,
        now: () => clock,
        syncDocuments: async (_files: SourceFile[], o: SyncOptions) => {
          const t0 = clock;
          o.onProgress?.({ phase: "start", changedFiles: opts.total, totalFiles: opts.total + 3, changedBytes: opts.bytesTotal });
          for (const step of opts.steps) {
            clock = t0 + step.at;
            o.onProgress?.({ phase: "progress", done: step.done, total: opts.total, bytesDone: step.bytesDone, bytesTotal: opts.bytesTotal });
          }
          clock = t0 + (opts.endAt ?? opts.steps.at(-1)?.at ?? 0);
          const last = opts.steps.at(-1);
          o.onProgress?.({ phase: "done", done: last?.done ?? 0, total: opts.total, bytesDone: last?.bytesDone ?? 0, bytesTotal: opts.bytesTotal, failures: opts.failures ?? 0, ms: clock - t0, fallbacks: opts.fallbacks ?? 0 });
          return EMPTY;
        },
        log: (m) => logs.push(m),
        emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
      });
      return { sync, logs, events };
    };

    it("says how many files and how much text need synopses", async () => {
      const { sync, logs } = setup({ total: 34, bytesTotal: 3_400_000, steps: [] });
      await sync("x");
      expect(logs[0]).toBe("context: writing synopses for 34 changed files, 3.2 MB of text (a first sync can take a few minutes)");
    });

    it("weighs progress by text, and estimates time left only from measured throughput", async () => {
      const { sync, logs } = setup({
        total: 34,
        bytesTotal: 3_400_000,
        steps: [
          { at: 10_000, done: 1, bytesDone: 100_000 },
          { at: 60_000, done: 2, bytesDone: 200_000 },
        ],
      });
      await sync("x");
      const lines = logs.filter((l) => l.startsWith("context: synopses ") && l.includes("files ·"));
      // One file in 10 s: too little to measure yet.
      expect(lines[0]).toBe("context: synopses 1/34 files · 3% of text · estimating…");
      // 200,000 bytes in 60 s is 195 KB/min; 3,200,000 bytes left at that rate is 16 minutes.
      expect(lines[1]).toBe("context: synopses 2/34 files · 6% of text · about 16 min left at 195 KB/min");
    });

    it("estimates after 30 seconds even with one file done, and says when it's under a minute", async () => {
      const slow = setup({ total: 10, bytesTotal: 1_000_000, steps: [{ at: 40_000, done: 1, bytesDone: 500_000 }] });
      await slow.sync("x");
      // 500,000 bytes in 40 s leaves 500,000 more: 40 s, under a minute.
      expect(slow.logs).toContain("context: synopses 1/10 files · 50% of text · under a minute left at 732 KB/min");
    });

    it("ends with the files, the text and the time taken, and any failures", async () => {
      const { sync, logs } = setup({
        total: 4,
        bytesTotal: 400_000,
        failures: 1,
        steps: [
          { at: 60_000, done: 2, bytesDone: 200_000 },
          { at: 120_000, done: 4, bytesDone: 400_000 },
        ],
      });
      await sync("x");
      expect(logs).toContain("context: synopses 4/4 files · 100% of text");
      expect(logs.at(-1)).toBe("context: synopses written for 4 files, 391 KB of text, in 2m 0s at 195 KB/min; 1 failed and loads whole");
    });

    it("says how many sections fell back to first sentences", async () => {
      const { sync, logs, events } = setup({ total: 2, bytesTotal: 200_000, fallbacks: 12, steps: [{ at: 60_000, done: 2, bytesDone: 200_000 }] });
      await sync("x");
      expect(logs.at(-1)).toBe("context: synopses written for 2 files, 195 KB of text, in 1m 0s at 195 KB/min · 12 sections fell back to first sentences");
      expect(events.at(-1)!.payload).toMatchObject({ fallbacks: 12 });
    });

    it("says when nothing changed", async () => {
      const { sync, logs } = setup({ total: 0, bytesTotal: 0, steps: [] });
      await sync("x");
      expect(logs).toEqual(["context: sections up to date"]);
    });

    it("emits the same numbers on the event bus, and nothing but numbers", async () => {
      const { sync, events } = setup({
        total: 34,
        bytesTotal: 3_400_000,
        steps: [
          { at: 10_000, done: 1, bytesDone: 100_000 },
          { at: 60_000, done: 2, bytesDone: 200_000 },
        ],
      });
      await sync("x");
      expect(events.map((e) => e.type)).toEqual(["context:sync-start", "context:sync-progress", "context:sync-progress", "context:sync-done"]);
      expect(events[0].payload).toMatchObject({ changedFiles: 34, totalFiles: 37, changedBytes: 3_400_000 });
      expect(events[1].payload).toMatchObject({ done: 1, total: 34, bytesDone: 100_000, bytesTotal: 3_400_000 });
      expect(events[1].payload).not.toHaveProperty("etaMs");
      expect(events[2].payload).toMatchObject({ done: 2, bytesDone: 200_000, etaMs: 960_000, bytesPerMinute: 200_000 });
      for (const e of events) for (const [k, v] of Object.entries(e.payload)) expect(typeof v, `${e.type}.${k}`).toBe("number");
    });

    it("reports the end even when the sync throws after it started, so nothing waits on it forever", async () => {
      const logs: string[] = [];
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const sync = createSectionSync({
        projectId: "acme",
        paths: ["docs/"],
        listSwarmFiles: async () => [],
        listProjectFiles: async () => [],
        commitOf: async () => null,
        syncDocuments: async (_f, o) => {
          o.onProgress?.({ phase: "start", changedFiles: 5, totalFiles: 9, changedBytes: 500 });
          o.onProgress?.({ phase: "progress", done: 2, total: 5, bytesDone: 200, bytesTotal: 500 });
          throw new Error("substrate down");
        },
        log: (m) => logs.push(m),
        emit: (type, payload) => events.push({ type, payload: payload as Record<string, unknown> }),
      });
      await sync("x");
      expect(events.at(-1)).toMatchObject({ type: "context:sync-done", payload: { done: 2, total: 5, bytesDone: 200, bytesTotal: 500, failures: 3, fallbacks: 0 } });
      expect(logs.join("\n")).toContain("substrate down");
    });

    it("passes the configured concurrency to the sync", async () => {
      let seen: number | undefined;
      const sync = createSectionSync({
        projectId: "acme",
        paths: ["docs/"],
        concurrency: 2,
        listSwarmFiles: async () => [],
        listProjectFiles: async () => [],
        commitOf: async () => null,
        syncDocuments: async (_f, opts) => {
          seen = opts.concurrency;
          return EMPTY;
        },
        log: () => {},
      });
      await sync("x");
      expect(seen).toBe(2);
    });
  });

  it("never throws: a failed sync is logged and the task loads whole files", async () => {
    const logs: string[] = [];
    const sync = createSectionSync({
      projectId: "acme",
      paths: ["docs/"],
      listSwarmFiles: async () => [],
      listProjectFiles: async () => [],
      commitOf: async () => null,
      syncDocuments: async () => {
        throw new Error("substrate down");
      },
      log: (m) => logs.push(m),
    });
    await expect(sync("x")).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("substrate down");
  });
});

describe("listSwarmMarkdown", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-md-"));
    mkdirSync(join(dir, "core"), { recursive: true });
    mkdirSync(join(dir, "domains", "acme"), { recursive: true });
    mkdirSync(join(dir, "notes"), { recursive: true });
    writeFileSync(join(dir, "core", "rules.md"), "# Rules");
    writeFileSync(join(dir, "core", "README.md"), "# not content");
    writeFileSync(join(dir, "domains", "acme", "architecture.md"), "# Arch");
    writeFileSync(join(dir, "domains", "acme", "config.json"), "{}");
    writeFileSync(join(dir, "notes", "x.md"), "# not a tier");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists the markdown seed stores as SwarmContent, with the same paths", async () => {
    const files = await listSwarmMarkdown(dir);
    expect(files.map((f) => f.path)).toEqual(["core/rules.md", "domains/acme/architecture.md"]);
  });

  it("is empty for a swarm dir that doesn't exist, and throws when a folder can't be read", async () => {
    expect(await listSwarmMarkdown(join(dir, "missing"))).toEqual([]);
    chmodSync(join(dir, "domains", "acme"), 0o000);
    try {
      await expect(listSwarmMarkdown(dir)).rejects.toThrow();
    } finally {
      chmodSync(join(dir, "domains", "acme"), 0o755);
    }
  });
});

describe("validateContextConfig: context.ranking", () => {
  const on = { sections: { enabled: true } };
  it("accepts ranking with sections, with defaults or with every setting", () => {
    expect(validateContextConfig({ ...on, ranking: { enabled: true } })).toEqual([]);
    expect(validateContextConfig({ ...on, ranking: { enabled: true, model: "nomic-embed-text", dimension: 768, ollamaUrl: "http://127.0.0.1:11434" } })).toEqual([]);
  });

  it("needs sections, since it ranks stored sections", () => {
    expect(validateContextConfig({ ranking: { enabled: true } })).toEqual([expect.stringMatching(/context.ranking needs context.sections.enabled/)]);
  });

  it("names each bad setting", () => {
    const errors = validateContextConfig({ ...on, ranking: { enabled: "yes", model: "", dimension: 0, ollamaUrl: "ftp://x", maxSections: 0, timeoutMs: 50, top: 3 } });
    expect(errors).toEqual([
      expect.stringMatching(/context.ranking.enabled must be true or false/),
      expect.stringMatching(/context.ranking.model must be an Ollama model name/),
      expect.stringMatching(/context.ranking.dimension must be a positive whole number/),
      expect.stringMatching(/context.ranking.ollamaUrl must be an http/),
      expect.stringMatching(/context.ranking.maxSections must be a whole number from 1 to 40/),
      expect.stringMatching(/context.ranking.timeoutMs must be a whole number of milliseconds/),
      expect.stringMatching(/context.ranking.top is not a setting/),
    ]);
  });

  it("asks for the dimension of a model it doesn't know", () => {
    expect(validateContextConfig({ ...on, ranking: { enabled: true, model: "my-embedder" } })).toEqual([
      expect.stringMatching(/set context.ranking.dimension/),
    ]);
  });
});

describe("resolveContextRanking and rankingEnv", () => {
  it("is off unless ranking and sections are both on", () => {
    expect(resolveContextRanking(undefined)).toBeNull();
    expect(resolveContextRanking({ ranking: { enabled: true } })).toBeNull();
    expect(resolveContextRanking({ sections: { enabled: true }, ranking: { enabled: false } })).toBeNull();
  });

  it("defaults to bge-m3 at 1024 dimensions on this machine's Ollama", () => {
    expect(resolveContextRanking({ sections: { enabled: true }, ranking: { enabled: true } })).toEqual({
      model: "bge-m3",
      dimension: 1024,
      ollamaUrl: "http://127.0.0.1:11434",
      maxSections: 5,
      timeoutMs: 15000,
    });
    expect(resolveContextRanking({ sections: { enabled: true }, ranking: { enabled: true, maxSections: 12 } })?.maxSections).toBe(12);
  });

  it("becomes the sidecar's embedder variables, with embedding on write", () => {
    expect(rankingEnv({ model: "bge-m3", dimension: 1024, ollamaUrl: "http://127.0.0.1:11434", timeoutMs: 15000 })).toEqual({
      SWARM_EMBEDDER_KIND: "ollama",
      SWARM_EMBEDDER_OLLAMA_URL: "http://127.0.0.1:11434",
      SWARM_EMBEDDER_MODEL: "bge-m3",
      SWARM_EMBEDDER_DIMENSION: "1024",
      SWARM_EMBEDDER_TIMEOUT_MS: "15000",
      SWARM_EMBED_ON_WRITE: "1",
    });
  });

  it("are what the lifecycle reads into the sidecars' embedder settings", () => {
    const env = rankingEnv({ model: "bge-m3", dimension: 1024, ollamaUrl: "http://127.0.0.1:11434", timeoutMs: 20000 });
    expect(resolveEmbedderSettings(env)).toEqual({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "bge-m3",
      dimension: 1024,
      timeoutMs: 20000,
      embedOnWrite: true,
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillFetcher } from "../src/index.js";
import type { Route, ISwarmEventBus, SwarmEventMap } from "@mnmal-ai/swarm-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(load: Record<string, string[]>): Route {
  return {
    intent: "code-review",
    description: "test route",
    load,
    keywords: ["test"],
  };
}

/** Minimal event bus that records emitted events. */
function createTestBus() {
  const events: Array<{ event: string; payload: unknown }> = [];
  const bus: ISwarmEventBus = {
    emit<K extends keyof SwarmEventMap>(event: K, payload: SwarmEventMap[K]) {
      events.push({ event, payload });
    },
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    onAny: vi.fn().mockReturnValue(() => {}),
    removeAllListeners: vi.fn(),
  };
  return { bus, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillFetcher", () => {
  let swarmPath: string;

  beforeEach(async () => {
    swarmPath = await mkdtemp(join(tmpdir(), "swarm-skill-fetcher-"));
  });

  afterEach(async () => {
    await rm(swarmPath, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // -----------------------------------------------------------------------
  // 1. Local-only route passes through unchanged
  // -----------------------------------------------------------------------
  it("passes local-only routes through unchanged", async () => {
    const fetcher = new SkillFetcher(swarmPath);
    const route = makeRoute({
      core: ["core/values.md"],
      skills_vetted: ["skills/vetted/local-skill.md"],
    });

    const resolved = await fetcher.prefetch(route);

    expect(resolved.load["core"]).toEqual(["core/values.md"]);
    expect(resolved.load["skills_vetted"]).toEqual(["skills/vetted/local-skill.md"]);
  });

  // -----------------------------------------------------------------------
  // 2. URL entry replaced with cache path
  // -----------------------------------------------------------------------
  it("replaces URL entries with cache paths", async () => {
    const skillContent = "# SwiftUI Skill\nSome content here.";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(skillContent),
    }));

    const fetcher = new SkillFetcher(swarmPath);
    const route = makeRoute({
      skills_vetted: [
        "https://raw.githubusercontent.com/AvdLee/SwiftUI-Agent-Skill/main/SKILL.md",
      ],
    });

    const resolved = await fetcher.prefetch(route);

    expect(resolved.load["skills_vetted"]).toHaveLength(1);
    const cachePath = resolved.load["skills_vetted"][0];
    expect(cachePath).toContain(".cache/skills/");
    expect(cachePath).toMatch(/\.md$/);
    expect(cachePath.startsWith("https://")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 3. Cached file content matches fetched content
  // -----------------------------------------------------------------------
  it("writes fetched content to the cache file", async () => {
    const skillContent = "# Swift Concurrency\nAsync/await patterns.";

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(skillContent),
    }));

    const fetcher = new SkillFetcher(swarmPath);
    const route = makeRoute({
      skills_vetted: [
        "https://raw.githubusercontent.com/example/skill/main/SKILL.md",
      ],
    });

    const resolved = await fetcher.prefetch(route);
    const cachePath = resolved.load["skills_vetted"][0];

    // The cache path is relative to swarmPath
    const fullCachePath = join(swarmPath, cachePath);
    const cachedContent = await readFile(fullCachePath, "utf-8");
    expect(cachedContent).toBe(skillContent);
  });

  // -----------------------------------------------------------------------
  // 4. HTTP 404 → URL omitted, event emitted
  // -----------------------------------------------------------------------
  it("omits URL on 404 and emits skill:fetch_failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    }));

    const { bus, events } = createTestBus();
    const fetcher = new SkillFetcher(swarmPath, bus);
    const route = makeRoute({
      skills_vetted: [
        "https://raw.githubusercontent.com/example/missing/main/SKILL.md",
        "skills/vetted/local.md",
      ],
    });

    const resolved = await fetcher.prefetch(route);

    // URL entry is removed, local entry remains
    expect(resolved.load["skills_vetted"]).toEqual(["skills/vetted/local.md"]);

    // Event emitted
    const failEvent = events.find((e) => e.event === "skill:fetch_failed");
    expect(failEvent).toBeDefined();
    expect((failEvent!.payload as { statusCode: number }).statusCode).toBe(404);
  });

  // -----------------------------------------------------------------------
  // 5. Network error → graceful skip, event emitted
  // -----------------------------------------------------------------------
  it("gracefully skips on network error and emits event", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const { bus, events } = createTestBus();
    const fetcher = new SkillFetcher(swarmPath, bus);
    const route = makeRoute({
      skills_vetted: [
        "https://raw.githubusercontent.com/example/skill/main/SKILL.md",
      ],
    });

    const resolved = await fetcher.prefetch(route);

    // URL entry is removed
    expect(resolved.load["skills_vetted"]).toEqual([]);

    // Event emitted
    const failEvent = events.find((e) => e.event === "skill:fetch_failed");
    expect(failEvent).toBeDefined();
    expect((failEvent!.payload as { error: string }).error).toContain("ECONNREFUSED");
  });

  // -----------------------------------------------------------------------
  // 6. Same URL fetched twice → only one HTTP request (session dedup)
  // -----------------------------------------------------------------------
  it("deduplicates fetches for the same URL within a session", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("# Skill content"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const fetcher = new SkillFetcher(swarmPath);
    const url = "https://raw.githubusercontent.com/example/skill/main/SKILL.md";

    const route1 = makeRoute({ skills_vetted: [url] });
    const route2 = makeRoute({ skills_vetted: [url] });

    const resolved1 = await fetcher.prefetch(route1);
    const resolved2 = await fetcher.prefetch(route2);

    // Only one fetch call despite two prefetch calls
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Both resolve to the same cache path
    expect(resolved1.load["skills_vetted"][0]).toBe(resolved2.load["skills_vetted"][0]);
  });

  // -----------------------------------------------------------------------
  // 7. Same URL always produces the same cache filename (deterministic hash)
  // -----------------------------------------------------------------------
  it("produces deterministic cache filenames from URLs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("# Content"),
    }));

    const url = "https://raw.githubusercontent.com/AvdLee/SwiftUI-Agent-Skill/main/SKILL.md";

    // Two separate instances should produce the same filename
    const fetcher1 = new SkillFetcher(swarmPath);
    const fetcher2 = new SkillFetcher(swarmPath);

    const resolved1 = await fetcher1.prefetch(makeRoute({ skills_vetted: [url] }));
    const resolved2 = await fetcher2.prefetch(makeRoute({ skills_vetted: [url] }));

    expect(resolved1.load["skills_vetted"][0]).toBe(resolved2.load["skills_vetted"][0]);
  });

  // -----------------------------------------------------------------------
  // 8. Mixed route with URLs and local paths → both handled correctly
  // -----------------------------------------------------------------------
  it("handles mixed routes with both URLs and local paths", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("# Remote skill"),
    }));

    const { bus, events } = createTestBus();
    const fetcher = new SkillFetcher(swarmPath, bus);
    const route = makeRoute({
      core: ["core/values.md", "core/rules.md"],
      skills_vetted: [
        "https://raw.githubusercontent.com/example/skill-a/main/SKILL.md",
        "skills/vetted/xcodebuild-mcp.md",
        "https://raw.githubusercontent.com/example/skill-b/main/SKILL.md",
      ],
    });

    const resolved = await fetcher.prefetch(route);

    // Core is untouched
    expect(resolved.load["core"]).toEqual(["core/values.md", "core/rules.md"]);

    // skills_vetted: 2 URLs replaced with cache paths, 1 local path kept
    const vetted = resolved.load["skills_vetted"];
    expect(vetted).toHaveLength(3);
    expect(vetted[0]).toContain(".cache/skills/");
    expect(vetted[1]).toBe("skills/vetted/xcodebuild-mcp.md");
    expect(vetted[2]).toContain(".cache/skills/");

    // Two fetch events emitted
    const fetchEvents = events.filter((e) => e.event === "skill:fetched");
    expect(fetchEvents).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // 9. Disk cache reuse — cached file on disk skips network request
  // -----------------------------------------------------------------------
  it("reuses cached files from disk without fetching", async () => {
    const url = "https://raw.githubusercontent.com/example/skill/main/SKILL.md";

    // First pass: fetch and cache
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("# Cached content"),
    }));

    const fetcher1 = new SkillFetcher(swarmPath);
    await fetcher1.prefetch(makeRoute({ skills_vetted: [url] }));

    // Reset fetch mock — new instance has no session cache
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const fetcher2 = new SkillFetcher(swarmPath);
    const resolved = await fetcher2.prefetch(makeRoute({ skills_vetted: [url] }));

    // No network request — file was already on disk
    expect(mockFetch).not.toHaveBeenCalled();
    expect(resolved.load["skills_vetted"]).toHaveLength(1);
    expect(resolved.load["skills_vetted"][0]).toContain(".cache/skills/");
  });

  // -----------------------------------------------------------------------
  // 10. Malformed URL → graceful skip, event emitted
  // -----------------------------------------------------------------------
  it("emits skill:fetch_failed for malformed URLs without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Invalid URL")));

    const { bus, events } = createTestBus();
    const fetcher = new SkillFetcher(swarmPath, bus);
    const route = makeRoute({
      skills_vetted: ["https://[invalid"],
    });

    const resolved = await fetcher.prefetch(route);

    // URL entry is removed
    expect(resolved.load["skills_vetted"]).toEqual([]);

    // Failure event emitted
    const failEvents = events.filter((e) => e.event === "skill:fetch_failed");
    expect(failEvents.length).toBeGreaterThanOrEqual(1);
  });
});

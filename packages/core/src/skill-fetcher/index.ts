import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { Route, ISwarmEventBus } from "@mnmal-ai/swarm-types";

const CACHE_DIR = ".cache/skills";
const FETCH_TIMEOUT_MS = 10_000;

export class SkillFetcher {
  private swarmPath: string;
  private eventBus?: ISwarmEventBus;
  /** Session-level dedup: URL → resolved cache path. */
  private sessionCache = new Map<string, string>();

  constructor(swarmPath: string, eventBus?: ISwarmEventBus) {
    this.swarmPath = swarmPath;
    this.eventBus = eventBus;
  }

  /**
   * Resolve remote URLs in a route to local cache paths.
   * Local path entries pass through unchanged.
   * Returns a new Route with all URLs replaced by cache paths.
   */
  async prefetch(route: Route): Promise<Route> {
    const resolvedLoad: Record<string, string[]> = {};

    for (const [tier, entries] of Object.entries(route.load)) {
      const resolvedEntries: string[] = [];

      for (const entry of entries) {
        if (!isUrl(entry)) {
          resolvedEntries.push(entry);
          continue;
        }

        const cachePath = await this.fetchAndCache(entry);
        if (cachePath !== null) {
          resolvedEntries.push(cachePath);
        }
        // If null, the URL was skipped (failed fetch) — omit from route
      }

      resolvedLoad[tier] = resolvedEntries;
    }

    return { ...route, load: resolvedLoad };
  }

  private async fetchAndCache(url: string): Promise<string | null> {
    // Session dedup — avoid re-fetching within the same Swarm instance
    const cached = this.sessionCache.get(url);
    if (cached !== undefined) {
      return cached;
    }

    // Disk cache check — reuse files from previous runs without a network request
    const cachePath = this.cachePathForUrl(url);
    const fullCachePath = join(this.swarmPath, cachePath);
    try {
      await access(fullCachePath);
      // File exists on disk — skip fetch
      this.sessionCache.set(url, cachePath);
      return cachePath;
    } catch {
      // File doesn't exist — proceed to fetch
    }

    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        this.eventBus?.emit("skill:fetch_failed", {
          url,
          error: `HTTP ${response.status} ${response.statusText}`,
          statusCode: response.status,
          timestamp: Date.now(),
        });
        return null;
      }

      const content = await response.text();
      await this.writeToCacheDir(cachePath, content);
      const latencyMs = Date.now() - startTime;

      this.sessionCache.set(url, cachePath);

      this.eventBus?.emit("skill:fetched", {
        url,
        cachePath,
        sizeBytes: Buffer.byteLength(content, "utf-8"),
        estimatedTokens: Math.ceil(content.length / 4),
        latencyMs,
        timestamp: Date.now(),
      });

      return cachePath;
    } catch (err) {
      this.eventBus?.emit("skill:fetch_failed", {
        url,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
      return null;
    }
  }

  /** Deterministic cache path for a URL, relative to swarmPath. */
  private cachePathForUrl(url: string): string {
    let ext = ".md";
    try {
      ext = extname(new URL(url).pathname) || ".md";
    } catch {
      // Malformed URL — fall back to .md extension
    }
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    return join(CACHE_DIR, `${hash}${ext}`);
  }

  private async writeToCacheDir(cachePath: string, content: string): Promise<void> {
    const fullPath = join(this.swarmPath, cachePath);
    await mkdir(join(this.swarmPath, CACHE_DIR), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
}

/**
 * HTTPS-only by design. HTTP URLs are not supported to prevent
 * loading skill content over unencrypted connections. Swarm maintainers
 * should always use raw.githubusercontent.com HTTPS URLs.
 */
function isUrl(entry: string): boolean {
  return entry.startsWith("https://");
}

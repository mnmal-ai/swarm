import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Router, Loader, selectReviewerFiles } from "../src/index.js";
import config from "./route-coverage.config.json";
import { FIXTURE_CONTENT_PATH, resolveSwarmPath } from "./content-path.js";

// ---------------------------------------------------------------------------
// Types for the config
// ---------------------------------------------------------------------------

interface RegressionCheck {
  id: string;
  route: string;
  tier: string;
  filePattern: string;
  reason: string;
}

type RouteTiers = Record<string, string[]>;
type EffectiveRoutes = Record<string, RouteTiers>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeOverrides(
  defaults: Record<string, RouteTiers>,
  overrides: Record<string, RouteTiers>,
): EffectiveRoutes {
  const result = structuredClone(defaults);
  for (const [route, tiers] of Object.entries(overrides)) {
    if (!result[route]) result[route] = {};
    for (const [tier, files] of Object.entries(tiers)) {
      result[route][tier] = files; // full replacement
    }
  }
  return result;
}

function isRemoteUrl(p: string): boolean {
  return p.startsWith("http://") || p.startsWith("https://");
}

function resolveProjectPaths(files: string[], project: string): string[] {
  return files.map((f) => f.replace(/\{project\}/g, project));
}

function collectAllLocalFiles(
  routes: EffectiveRoutes,
  projects: string[],
): string[] {
  const all = new Set<string>();
  for (const tiers of Object.values(routes)) {
    for (const files of Object.values(tiers)) {
      for (const file of files) {
        if (isRemoteUrl(file)) continue;
        if (file.includes("{project}")) {
          for (const project of projects) {
            all.add(file.replace(/\{project\}/g, project));
          }
        } else {
          all.add(file);
        }
      }
    }
  }
  return [...all];
}

async function discoverSwarmContentFiles(swarmPath: string): Promise<string[]> {
  const contentDirs = ["core", "modes", "capabilities", "oversight", "skills"];
  const files: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".json")) {
        files.push(rel);
      }
    }
  };

  for (const dir of contentDirs) {
    await walk(path.join(swarmPath, dir), dir);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Resolve config at module scope — test cases derived from this
// ---------------------------------------------------------------------------

// The config's swarmPath when set, else always the repo fixture
// (tests/fixtures/content), never SWARM_PATH: route-coverage.config.json
// describes the fixture, so a real corpus in SWARM_PATH would fail the config
// sync. Throws when the content set is missing rather than skipping.
const swarmPath = resolveSwarmPath(config.swarmPath || FIXTURE_CONTENT_PATH);
const effectiveRoutes = mergeOverrides(
  config.routes as Record<string, RouteTiers>,
  config.overrides as Record<string, RouteTiers>,
);
const routeNames = Object.keys(effectiveRoutes);
const nonFallbackRoutes = routeNames.filter((r) => r !== "fallback");

// Build file existence test cases: [route, tier, filePath]
const fileExistenceCases: [string, string, string][] = [];
for (const [route, tiers] of Object.entries(effectiveRoutes)) {
  for (const [tier, files] of Object.entries(tiers)) {
    for (const file of files) {
      if (isRemoteUrl(file)) continue;
      if (file.includes("{project}")) {
        for (const project of config.knownProjects) {
          fileExistenceCases.push([
            route,
            tier,
            file.replace(/\{project\}/g, project),
          ]);
        }
      } else {
        fileExistenceCases.push([route, tier, file]);
      }
    }
  }
}

// Build required-tier test cases: [route, tier]
const requiredTierCases: [string, string][] = [];
for (const route of nonFallbackRoutes) {
  for (const tier of config.requiredTiers) {
    requiredTierCases.push([route, tier]);
  }
}

// Build domain resolution cases: [project, route, filePath]
const domainResolutionCases: [string, string, string][] = [];
for (const [route, tiers] of Object.entries(effectiveRoutes)) {
  const domainFiles = tiers["domain"];
  if (!domainFiles) continue;
  for (const project of config.knownProjects) {
    for (const file of domainFiles) {
      if (file.includes("{project}")) {
        domainResolutionCases.push([
          project,
          route,
          file.replace(/\{project\}/g, project),
        ]);
      }
    }
  }
}

// Build regression guard cases: [id, route, tier, filePattern, reason]
const regressionCases = (
  config.regressionChecks as RegressionCheck[]
).map((r) => [r.id, r.route, r.tier, r.filePattern, r.reason] as const);

// Build integration route+project cases: [route, project | null]
const integrationCases: [string, string | null][] = [];
for (const route of nonFallbackRoutes) {
  const hasDomain = effectiveRoutes[route]["domain"]?.some((f: string) =>
    f.includes("{project}"),
  );
  if (hasDomain) {
    for (const project of config.knownProjects) {
      integrationCases.push([route, project]);
    }
  } else {
    integrationCases.push([route, null]);
  }
}

// ===========================================================================
// Block 1: Structural Tests
// ===========================================================================

describe("Route Coverage — Structural", () => {
  let swarmManifest: {
    routes: Array<{ intent: string; load: Record<string, string[]> }>;
    fallback: { load: Record<string, string[]> };
  };

  beforeAll(async () => {
    const raw = await fs.readFile(path.join(swarmPath, "swarm.json"), "utf-8");
    swarmManifest = JSON.parse(raw);
  });

  // -------------------------------------------------------------------------
  // Config sync — config route names match swarm.json intents
  // -------------------------------------------------------------------------

  describe("Config sync", () => {
    it("every swarm.json route has a matching config entry", () => {
      const swarmIntents = swarmManifest.routes.map((r) => r.intent);
      for (const intent of swarmIntents) {
        expect(
          effectiveRoutes[intent],
          `swarm.json route "${intent}" has no config entry`,
        ).toBeDefined();
      }
    });

    it("every config route (except fallback) has a matching swarm.json route", () => {
      const swarmIntents = new Set(swarmManifest.routes.map((r) => r.intent));
      for (const route of nonFallbackRoutes) {
        expect(
          swarmIntents.has(route),
          `config route "${route}" not found in swarm.json`,
        ).toBe(true);
      }
    });

    it("fallback config matches swarm.json fallback", () => {
      expect(effectiveRoutes["fallback"]).toBeDefined();
      const swarmFallback = swarmManifest.fallback.load;
      const configFallback = effectiveRoutes["fallback"];
      for (const [tier, files] of Object.entries(swarmFallback)) {
        expect(
          configFallback[tier],
          `fallback tier "${tier}" missing from config`,
        ).toEqual(files);
      }
    });

    it("non-fallback route tiers match swarm.json exactly (respecting overrides)", () => {
      const overrides = config.overrides as Record<string, RouteTiers>;

      for (const swarmRoute of swarmManifest.routes) {
        const routeName = swarmRoute.intent;
        const effectiveRoute = effectiveRoutes[routeName];
        if (!effectiveRoute) continue; // caught by earlier test

        for (const [tier, swarmFiles] of Object.entries(swarmRoute.load)) {
          const isOverridden = overrides[routeName]?.[tier] !== undefined;
          if (isOverridden) {
            // Override provided — skip swarm.json comparison for this tier
            continue;
          }
          expect(
            effectiveRoute[tier],
            `${routeName}/${tier}: config does not match swarm.json`,
          ).toEqual(swarmFiles);
        }

        // Check config doesn't have extra tiers not in swarm.json (excluding overridden)
        for (const tier of Object.keys(effectiveRoute)) {
          const isOverridden = overrides[routeName]?.[tier] !== undefined;
          if (isOverridden) continue;
          if (swarmRoute.load[tier] === undefined) {
            // Config has a tier that swarm.json doesn't — fail unless it's empty
            expect(
              effectiveRoute[tier],
              `${routeName}: config has tier "${tier}" not in swarm.json`,
            ).toEqual([]);
          }
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // File existence — every referenced local file exists on disk
  // -------------------------------------------------------------------------

  describe("File existence", () => {
    it.each(fileExistenceCases)(
      "%s / %s: %s exists",
      async (_route, _tier, filePath) => {
        await expect(
          fs.access(path.join(swarmPath, filePath)),
        ).resolves.toBeUndefined();
      },
    );
  });

  // -------------------------------------------------------------------------
  // Required tiers — every non-fallback route has non-empty required tiers
  // -------------------------------------------------------------------------

  describe("Required tiers", () => {
    it.each(requiredTierCases)(
      "%s has non-empty %s tier",
      (route, tier) => {
        const files = effectiveRoutes[route][tier];
        expect(
          files,
          `route "${route}" is missing required tier "${tier}"`,
        ).toBeDefined();
        expect(
          files.length,
          `route "${route}" has empty required tier "${tier}"`,
        ).toBeGreaterThan(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Orphan detection — every content file is referenced by at least one route
  // -------------------------------------------------------------------------

  describe("Orphan detection", () => {
    let contentFiles: string[];
    let referencedFiles: Set<string>;

    beforeAll(async () => {
      contentFiles = await discoverSwarmContentFiles(swarmPath);
      const allReferenced = collectAllLocalFiles(
        effectiveRoutes,
        config.knownProjects,
      );
      referencedFiles = new Set(allReferenced);
    });

    it("every mode file has a route", () => {
      const modeFiles = contentFiles.filter((f) => f.startsWith("modes/"));
      for (const file of modeFiles) {
        expect(
          referencedFiles.has(file),
          `mode file "${file}" is not referenced by any route`,
        ).toBe(true);
      }
    });

    it("every core file is referenced", () => {
      const coreFiles = contentFiles.filter((f) => f.startsWith("core/"));
      for (const file of coreFiles) {
        expect(
          referencedFiles.has(file),
          `core file "${file}" is not referenced by any route`,
        ).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Domain resolution — domain paths resolve per known project
  // -------------------------------------------------------------------------

  // A content set with no domain-tier routes (the repo fixture) has no cases here.
  describe.skipIf(domainResolutionCases.length === 0)("Domain resolution", () => {
    it.each(domainResolutionCases)(
      "project %s / %s: %s exists",
      async (_project, _route, filePath) => {
        await expect(
          fs.access(path.join(swarmPath, filePath)),
        ).resolves.toBeUndefined();
      },
    );
  });

  // -------------------------------------------------------------------------
  // Regression guards — named assertions from incident context
  // -------------------------------------------------------------------------

  describe("Regression guards", () => {
    it.each(regressionCases)(
      "%s: %s/%s contains %s",
      (_id, route, tier, filePattern) => {
        const routeTiers = effectiveRoutes[route];
        expect(
          routeTiers,
          `regression guard references route "${route}" which doesn't exist`,
        ).toBeDefined();

        const tierFiles = routeTiers[tier];
        expect(
          tierFiles,
          `regression guard references tier "${tier}" in route "${route}" which doesn't exist`,
        ).toBeDefined();

        const match = tierFiles.some((f: string) => f.includes(filePattern));
        expect(
          match,
          `regression guard "${_id}": no file matching "${filePattern}" in ${route}/${tier}. Files: ${JSON.stringify(tierFiles)}`,
        ).toBe(true);
      },
    );
  });
});

// ===========================================================================
// Block 2: Role Filtering
// ===========================================================================

// TODO: Convert to Substrate mock data. Router and Loader now require a SubstrateClient,
// not a swarmPath string. These tests need mock SwarmRoute, SwarmConfig, and
// SwarmContent entities built from the real swarm repo data. Skipped for PoC.
describe.skip("Route Coverage — Role Filtering", () => {
  let router: Router;
  let loader: Loader;

  beforeAll(() => {
    router = new Router(swarmPath as any);
    loader = new Loader(swarmPath as any);
  });

  // -------------------------------------------------------------------------
  // Worker receives all tiers present in the route config
  // -------------------------------------------------------------------------

  describe("Worker receives all tiers", () => {
    it.each(nonFallbackRoutes)(
      "route %s: worker LoadResult covers all config tiers",
      async (routeName) => {
        const classification = await router.classify("test", routeName);
        const budget = await router.getBudget("claude-opus-4-6");
        const priority = await router.getLoadingPriority();
        const project = config.knownProjects[0];

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          project,
        );

        const loadedPaths = new Set(loadResult.files.map((f) => f.path));

        // For each tier in config, check that every local+existing file was loaded
        const routeConfig = effectiveRoutes[routeName];
        for (const [tier, configFiles] of Object.entries(routeConfig)) {
          const resolved = resolveProjectPaths(
            configFiles as string[],
            project,
          );
          for (const file of resolved) {
            if (isRemoteUrl(file)) continue;
            // Only assert files that exist on disk (loader skips missing files)
            try {
              await fs.access(path.join(swarmPath, file));
              expect(
                loadedPaths.has(file),
                `worker missing ${file} from ${routeName}/${tier}`,
              ).toBe(true);
            } catch {
              // file doesn't exist on disk — loader skips it
            }
          }
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // Reviewer excludes non-review tiers
  // -------------------------------------------------------------------------

  describe("Reviewer excludes non-review tiers", () => {
    const reviewerTiers = new Set(
      (config.roles.reviewer.tiers as string[]),
    );

    it.each(nonFallbackRoutes)(
      "route %s: reviewer context contains only mode+domain+oversight",
      async (routeName) => {
        const classification = await router.classify("test", routeName);
        const budget = await router.getBudget("claude-opus-4-6");
        const priority = await router.getLoadingPriority();
        const project = config.knownProjects[0];

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          project,
        );

        const reviewerContext = selectReviewerFiles(loadResult.files);

        // Reviewer context should NOT contain core/, capabilities/, or skills/ paths
        for (const file of loadResult.files) {
          if (reviewerTiers.has(file.tier)) {
            // Should appear in reviewer context
            if (reviewerContext.length > 0) {
              expect(
                reviewerContext.includes(file.path),
                `reviewer should include ${file.path} (tier: ${file.tier})`,
              ).toBe(true);
            }
          } else {
            // Should NOT appear in reviewer context
            expect(
              reviewerContext.includes(`--- ${file.path}`),
              `reviewer should exclude ${file.path} (tier: ${file.tier})`,
            ).toBe(false);
          }
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // Orchestrator gets conventions and definition-of-done per project
  // -------------------------------------------------------------------------

  describe("Orchestrator loads critical domain files", () => {
    it.each(config.knownProjects)(
      "orchestration route loads conventions.md and definition-of-done.md for project %s",
      async (project) => {
        const classification = await router.classify("test", "orchestration");
        const budget = await router.getBudget("claude-opus-4-6");
        const priority = await router.getLoadingPriority();

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          project,
        );

        const loadedPaths = loadResult.files.map((f) => f.path);

        expect(
          loadedPaths,
          `orchestration missing conventions.md for ${project}`,
        ).toContain(`domains/${project}/conventions.md`);

        expect(
          loadedPaths,
          `orchestration missing definition-of-done.md for ${project}`,
        ).toContain(`domains/${project}/definition-of-done.md`);
      },
    );
  });
});

// ===========================================================================
// Block 3: Integration
// ===========================================================================

// TODO: Convert to Substrate mock data. Router and Loader now require a SubstrateClient,
// not a swarmPath string. These tests need mock SwarmRoute, SwarmConfig, and
// SwarmContent entities built from the real swarm repo data. Skipped for PoC.
describe.skip("Route Coverage — Integration", () => {
  let router: Router;
  let loader: Loader;

  beforeAll(() => {
    router = new Router(swarmPath as any);
    loader = new Loader(swarmPath as any);
  });

  // -------------------------------------------------------------------------
  // Intent override classification returns correct route
  // -------------------------------------------------------------------------

  describe("Intent override classification", () => {
    it.each(nonFallbackRoutes)(
      "classify with intent override %s returns matching route",
      async (intent) => {
        const result = await router.classify("test", intent);
        expect(result.intent).toBe(intent);
        expect(result.confidence).toBe("exact");
        expect(result.route.load).toBeDefined();

        // Verify the route load config has the tiers we expect from config
        const configRoute = effectiveRoutes[intent];
        for (const tier of Object.keys(configRoute)) {
          const configFiles = configRoute[tier] as string[];
          if (configFiles.length === 0) continue;
          expect(
            result.route.load[tier],
            `route ${intent} missing tier "${tier}" in swarm.json load config`,
          ).toBeDefined();
        }
      },
    );

    it("fallback classification works for unknown intent", async () => {
      const result = await router.classify("xyzzy gibberish nonsense");
      expect(result.intent).toBe("fallback");
      expect(result.confidence).toBe("fallback");
      expect(result.route.load["core"]).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Loader produces expected files (bidirectional check)
  // -------------------------------------------------------------------------

  describe("Loader produces expected files", () => {
    it.each(integrationCases)(
      "route %s (project: %s): loaded files match config",
      async (routeName, project) => {
        const classification = await router.classify("test", routeName);
        const budget = await router.getBudget("claude-opus-4-6");
        const priority = await router.getLoadingPriority();

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          project ?? undefined,
        );

        const loadedPaths = new Set(loadResult.files.map((f) => f.path));
        const routeConfig = effectiveRoutes[routeName];

        // Direction 1: every local config file that exists on disk should be loaded
        for (const [tier, configFiles] of Object.entries(routeConfig)) {
          const resolved = project
            ? resolveProjectPaths(configFiles as string[], project)
            : (configFiles as string[]);

          for (const file of resolved) {
            if (isRemoteUrl(file)) continue;
            try {
              await fs.access(path.join(swarmPath, file));
              // File exists — it should be loaded (unless budget-truncated)
              if (!loadResult.truncated.includes(file)) {
                expect(
                  loadedPaths.has(file),
                  `config expects ${file} in ${routeName}/${tier} but loader didn't load it`,
                ).toBe(true);
              }
            } catch {
              // file doesn't exist — loader skips it, that's fine
            }
          }
        }

        // Direction 2: every loaded file should be in the config
        const allConfigFiles = new Set<string>();
        for (const files of Object.values(routeConfig)) {
          for (const file of files as string[]) {
            if (project && file.includes("{project}")) {
              allConfigFiles.add(file.replace(/\{project\}/g, project));
            } else {
              allConfigFiles.add(file);
            }
          }
        }

        for (const loadedPath of loadedPaths) {
          expect(
            allConfigFiles.has(loadedPath),
            `loader loaded ${loadedPath} for route ${routeName} but config doesn't expect it`,
          ).toBe(true);
        }
      },
    );
  });

  // -------------------------------------------------------------------------
  // Required tiers survive tiny budget
  // -------------------------------------------------------------------------

  describe("Required tiers survive tiny budget", () => {
    it("loading with budget=1 still loads core+mode+oversight; optional tiers truncated", async () => {
      // Use implementation route — it has the most optional tiers
      const classification = await router.classify("test", "implementation");
      const priority = await router.getLoadingPriority();
      const project = config.knownProjects[0];

      const loadResult = await loader.load(
        classification.route,
        1, // 1 token budget — only required tiers should survive
        priority,
        project,
      );

      const loadedTiers = new Set(loadResult.files.map((f) => f.tier));

      // Required tiers must be present
      expect(loadedTiers.has("core")).toBe(true);
      expect(loadedTiers.has("mode")).toBe(true);
      expect(loadedTiers.has("oversight")).toBe(true);

      // Optional tiers should be truncated (not loaded)
      expect(loadResult.truncated.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Reviewer filter on real LoadResult
  // -------------------------------------------------------------------------

  describe("Reviewer filter on real LoadResult", () => {
    it.each(nonFallbackRoutes)(
      "route %s: selectReviewerFiles returns only mode+domain+oversight",
      async (routeName) => {
        const classification = await router.classify("test", routeName);
        const budget = await router.getBudget("claude-opus-4-6");
        const priority = await router.getLoadingPriority();
        const project = config.knownProjects[0];

        const loadResult = await loader.load(
          classification.route,
          budget,
          priority,
          project,
        );

        const reviewerContext = selectReviewerFiles(loadResult.files);
        const excludedTiers = ["core", "capabilities", "skills_vetted", "skills_community"];

        for (const file of loadResult.files) {
          if (excludedTiers.includes(file.tier)) {
            expect(
              reviewerContext.includes(`--- ${file.path}`),
              `reviewer context should not contain ${file.tier} file: ${file.path}`,
            ).toBe(false);
          }
        }
      },
    );
  });
});

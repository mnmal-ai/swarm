/**
 * Two swarm projects sharing one Substrate.
 *
 * Runs the real `seedSwarmContent` for two projects against ONE in-memory
 * Substrate, then reads context back through the real run-time resolvers
 * (`loadContext`, `classifyIntent`) over the same rows. Before project scoping each
 * project's sync deleted the other's rows at a shared path (non-domain files
 * were all written as `projectId: "global"`), and the second project's route
 * for an intent was skipped because the first project already had one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { classifyIntent, loadContext } from "@mnmal-ai/swarm-substrate-plugin";
import type { SubstrateClient } from "@mnmal-ai/swarm-substrate";
import { seedSwarmContent } from "../src/cli/seed.js";

type Row = Record<string, unknown>;
type Where = Record<string, { eq?: unknown }>;

/**
 * One shared Substrate, in memory. `client()` is the surface `seedSwarmContent`
 * drives (query / ingest / deleteX mutations); `dataset()` is the surface the
 * resolvers read. Both see the same rows. `where: { field: { eq } }` is
 * honoured the way the server honours it: a row without the field never
 * matches.
 */
class SharedSubstrate {
  readonly rows = new Map<string, Row[]>();
  #nextId = 1;

  all(type: string): Row[] {
    return this.rows.get(type) ?? [];
  }

  insert(type: string, row: Row): void {
    this.rows.set(type, [...this.all(type), { id: `row-${this.#nextId++}`, ...row }]);
  }

  select(type: string, where?: Where): Row[] {
    return this.all(type).filter((row) =>
      Object.entries(where ?? {}).every(([field, cond]) =>
        cond.eq === undefined ? true : row[field] === cond.eq,
      ),
    );
  }

  client(): SubstrateClient {
    return {
      query: async (type: string, params: { where?: Where }) => this.select(type, params?.where),
      ingest: async (type: string, data: Row[]) => {
        for (const row of data) this.insert(type, row);
        return { accepted: data.length, typeName: type };
      },
      mutate: async (name: string, params: { id?: unknown }) => {
        if (name.startsWith("delete")) {
          const type = name.slice("delete".length);
          this.rows.set(type, this.all(type).filter((r) => r.id !== params.id));
        }
        if (name.startsWith("update")) {
          const type = name.slice("update".length);
          this.rows.set(type, this.all(type).map((r) => (r.id === params.id ? { ...r, ...params } : r)));
        }
        return { id: params.id };
      },
    } as unknown as SubstrateClient;
  }

  dataset(): unknown {
    return {
      read: async (type: string, params: { where?: Where }) => ({
        rows: this.select(type, params?.where),
        hasMore: false,
      }),
    };
  }
}

/** Write a swarm directory for `project`: swarm.json plus core, mode and domain
 *  files whose content names the project, so a leak is visible in the text. */
function writeSwarm(root: string, project: string, keyword: string): string {
  const swarmDir = join(root, project, ".swarm");
  const files: Record<string, string> = {
    "swarm.json": JSON.stringify({
      context_budget: { default_max_tokens: 10000 },
      routes: [
        {
          intent: "implementation",
          description: `Build for ${project}`,
          keywords: [keyword],
          load: {
            core: ["core/values.md"],
            mode: ["modes/implementation.md"],
            domain: ["domains/{project}/overview.md"],
          },
        },
      ],
    }),
    "core/values.md": `${project} values`,
    "modes/implementation.md": `${project} implementation mode`,
    [`domains/${project}/overview.md`]: `${project} overview`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(swarmDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return swarmDir;
}

async function load(substrate: SharedSubstrate, projectId: string) {
  return loadContext({} as never, {
    params: { intent: "implementation", projectId, modelId: "test-model" },
    dataset: substrate.dataset(),
  } as never);
}

async function classify(substrate: SharedSubstrate, projectId: string, prompt: string) {
  return classifyIntent({} as never, {
    params: { prompt, projectId },
    dataset: substrate.dataset(),
  } as never);
}

describe("seedSwarmContent — two projects sharing one Substrate", () => {
  let root: string;
  let swarmA: string;
  let swarmB: string;
  let substrate: SharedSubstrate;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "swarm-shared-substrate-"));
    swarmA = writeSwarm(root, "project-a", "build");
    swarmB = writeSwarm(root, "project-b", "ship");
    substrate = new SharedSubstrate();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps both projects' content for the same path through a sync from each", async () => {
    await seedSwarmContent(substrate.client(), swarmA, "project-a");
    await seedSwarmContent(substrate.client(), swarmB, "project-b");

    const values = substrate.all("SwarmContent").filter((r) => r.path === "core/values.md");
    expect(values.map((r) => [r.projectId, r.content]).sort()).toEqual([
      ["project-a", "project-a values"],
      ["project-b", "project-b values"],
    ]);

    // No ping-pong: re-syncing either project finds its own rows unchanged.
    expect(await seedSwarmContent(substrate.client(), swarmA, "project-a")).toMatchObject({ content: 0, routes: 0 });
    expect(await seedSwarmContent(substrate.client(), swarmB, "project-b")).toMatchObject({ content: 0, routes: 0 });
  });

  it("registers each project's route for the same intent", async () => {
    await seedSwarmContent(substrate.client(), swarmA, "project-a");
    await seedSwarmContent(substrate.client(), swarmB, "project-b");

    const routes = substrate.all("SwarmRoute").filter((r) => r.intent === "implementation");
    expect(routes.map((r) => r.projectId).sort()).toEqual(["project-a", "project-b"]);
  });

  it("loads each project's own content and route at run time", async () => {
    await seedSwarmContent(substrate.client(), swarmA, "project-a");
    await seedSwarmContent(substrate.client(), swarmB, "project-b");

    for (const [self, other] of [["project-a", "project-b"], ["project-b", "project-a"]]) {
      const result = await load(substrate, self);
      expect(result.routeMatched?.description).toBe(`Build for ${self}`);
      expect(result.content).toContain(`${self} values`);
      expect(result.content).toContain(`${self} implementation mode`);
      expect(result.content).toContain(`${self} overview`);
      expect(result.content).not.toContain(other);
    }
  });

  it("classifies each project's prompts against its own routes", async () => {
    await seedSwarmContent(substrate.client(), swarmA, "project-a");
    await seedSwarmContent(substrate.client(), swarmB, "project-b");

    expect((await classify(substrate, "project-b", "ship it")).intent).toBe("implementation");
    expect((await classify(substrate, "project-a", "ship it")).intent).toBe("fallback");
    expect((await classify(substrate, "project-a", "build it")).intent).toBe("implementation");
    expect((await classify(substrate, "project-b", "build it")).intent).toBe("fallback");
  });

  it("replaces a project's changed file without touching the other project's row", async () => {
    await seedSwarmContent(substrate.client(), swarmA, "project-a");
    await seedSwarmContent(substrate.client(), swarmB, "project-b");

    writeFileSync(join(swarmA, "core/values.md"), "project-a values, revised");
    const counts = await seedSwarmContent(substrate.client(), swarmA, "project-a");
    expect(counts.content).toBe(1);

    const values = substrate.all("SwarmContent").filter((r) => r.path === "core/values.md");
    expect(values.map((r) => [r.projectId, r.content]).sort()).toEqual([
      ["project-a", "project-a values, revised"],
      ["project-b", "project-b values"],
    ]);
    expect((await load(substrate, "project-a")).content).toContain("project-a values, revised");
    expect((await load(substrate, "project-b")).content).toContain("project-b values");
  });

  it("keeps loading a Substrate seeded before per-project rows, and leaves those rows alone", async () => {
    // What an older swarm wrote: non-domain content under "global", routes
    // with no projectId.
    substrate.insert("SwarmContent", {
      path: "core/values.md", tier: "core", intent: "all", content: "legacy values",
      tokenEstimate: 4, lastReviewed: "", projectId: "global",
    });
    substrate.insert("SwarmContent", {
      path: "modes/implementation.md", tier: "mode", intent: "all", content: "legacy mode",
      tokenEstimate: 4, lastReviewed: "", projectId: "global",
    });
    substrate.insert("SwarmRoute", {
      intent: "implementation", description: "Legacy build", keywords: '["build"]',
      contentPaths: '["core/values.md","modes/implementation.md"]',
    });

    // Before project-a has synced, it reads the legacy rows.
    const before = await load(substrate, "project-a");
    expect(before.routeMatched?.description).toBe("Legacy build");
    expect(before.content).toContain("legacy values");

    await seedSwarmContent(substrate.client(), swarmA, "project-a");

    // After, its own rows win; the legacy rows are still there for anyone
    // else reading them.
    const after = await load(substrate, "project-a");
    expect(after.routeMatched?.description).toBe("Build for project-a");
    expect(after.content).toContain("project-a values");
    expect(after.content).not.toContain("legacy");
    expect(substrate.all("SwarmContent").some((r) => r.content === "legacy values")).toBe(true);
    expect(substrate.all("SwarmRoute").some((r) => r.description === "Legacy build")).toBe(true);
  });

  it("updates a project's route in place when swarm.json changes it, and leaves the other project's alone", async () => {
    await seedSwarmContent(substrate.client(), swarmA, "project-a");
    await seedSwarmContent(substrate.client(), swarmB, "project-b");
    const bBefore = substrate.all("SwarmRoute").find((r) => r.projectId === "project-b");

    const swarmJson = join(swarmA, "swarm.json");
    writeFileSync(
      swarmJson,
      JSON.stringify({
        context_budget: { default_max_tokens: 10000 },
        routes: [
          {
            intent: "implementation",
            description: "Build for project-a, revised",
            keywords: ["build", "make"],
            load: { core: ["core/values.md"], mode: ["modes/implementation.md"] },
          },
        ],
      }),
    );
    const counts = await seedSwarmContent(substrate.client(), swarmA, "project-a");
    expect(counts.routes).toBe(1);

    const aRoutes = substrate.all("SwarmRoute").filter((r) => r.projectId === "project-a");
    expect(aRoutes).toHaveLength(1);
    expect(aRoutes[0]).toMatchObject({
      description: "Build for project-a, revised",
      keywords: JSON.stringify(["build", "make"]),
      contentPaths: JSON.stringify(["core/values.md", "modes/implementation.md"]),
    });
    expect(substrate.all("SwarmRoute").find((r) => r.projectId === "project-b")).toEqual(bBefore);

    const loaded = await load(substrate, "project-a");
    expect(loaded.routeMatched?.description).toBe("Build for project-a, revised");
    expect(loaded.content).not.toContain("project-a overview");

    // An unchanged route is left as it is.
    expect(await seedSwarmContent(substrate.client(), swarmA, "project-a")).toMatchObject({ routes: 0 });
  });

  it("writes no routes when it can't read the existing ones, rather than duplicating them", async () => {
    await seedSwarmContent(substrate.client(), swarmA, "project-a");
    const client = substrate.client();
    const failing = {
      ...client,
      query: async (type: string, params: { where?: Where }) => {
        if (type === "SwarmRoute") throw new Error("connection reset");
        return client.query(type, params as never);
      },
    } as unknown as SubstrateClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const counts = await seedSwarmContent(failing, swarmA, "project-a");

    expect(counts.routes).toBe(0);
    expect(substrate.all("SwarmRoute").filter((r) => r.projectId === "project-a")).toHaveLength(1);
    expect(warn.mock.calls.flat().join(" ")).toContain("connection reset");
    warn.mockRestore();
  });
});

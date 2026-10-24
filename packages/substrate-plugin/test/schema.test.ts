import { SWARM_META_TYPE_NAMES, SWARM_TYPE_NAMES } from "@mnmal-ai/swarm-substrate-shared";
import { describe, expect, it } from "vitest";
import { bootTestServer } from "./harness.js";

interface NamespaceSchema {
  types: Record<string, unknown>;
}

interface Envelope {
  data: Record<string, unknown>;
  errors?: Array<{ code?: string; message?: string }>;
}

describe("swarm substrate plugin schema", () => {
  it("cold scope publishes swarm and swarm-docs with every type", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      const swarmRes = await s.inject({ method: "GET", url: "/substrate/v1/schema/swarm" });
      expect(swarmRes.status).toBe(200);
      const swarm = swarmRes.json() as NamespaceSchema;
      // Substrate publishes the custom query entries (kind "type") beside the types.
      expect(Object.keys(swarm.types).sort()).toEqual(
        [...SWARM_TYPE_NAMES, "classifyIntent", "loadContext", "prepareTask"].sort(),
      );

      const docsRes = await s.inject({ method: "GET", url: "/substrate/v1/schema/swarm-docs" });
      expect(docsRes.status).toBe(200);
      const docs = docsRes.json() as NamespaceSchema;
      expect(Object.keys(docs.types).sort()).toEqual(["Document", "Section"]);

      const metaRes = await s.inject({ method: "GET", url: "/substrate/v1/schema/swarm_meta" });
      expect(metaRes.status).toBe(404);
    } finally {
      await s.stop();
    }
  });

  it("meta scope publishes only swarm_meta", async () => {
    const s = await bootTestServer({ scope: "meta" });
    try {
      const metaRes = await s.inject({ method: "GET", url: "/substrate/v1/schema/swarm_meta" });
      expect(metaRes.status).toBe(200);
      const meta = metaRes.json() as NamespaceSchema;
      expect(Object.keys(meta.types)).toHaveLength(5);
      expect(Object.keys(meta.types).sort()).toEqual([...SWARM_META_TYPE_NAMES].sort());

      const swarmRes = await s.inject({ method: "GET", url: "/substrate/v1/schema/swarm" });
      expect(swarmRes.status).toBe(404);
      const docsRes = await s.inject({ method: "GET", url: "/substrate/v1/schema/swarm-docs" });
      expect(docsRes.status).toBe(404);
    } finally {
      await s.stop();
    }
  });

  it("createSwarmConfig round-trips through autoCRUD", async () => {
    const s = await bootTestServer({ scope: "cold" });
    try {
      const created = (
        await s.inject({
          method: "POST",
          url: "/substrate/v1/mutate",
          body: {
            "swarm/createSwarmConfig": {
              params: { key: "budget_default", value: "4000", category: "budget" },
              fields: { id: true, key: true },
            },
          },
        })
      ).json() as Envelope;
      expect(created.errors ?? []).toEqual([]);
      const row = created.data["swarm/createSwarmConfig"] as { id: string; key: string };
      expect(row.key).toBe("budget_default");
      expect(typeof row.id).toBe("string");

      const queried = (
        await s.inject({
          method: "POST",
          url: "/substrate/v1/query",
          body: {
            "swarm/SwarmConfig": {
              params: { where: { key: { eq: "budget_default" } } },
              fields: { id: true, key: true, value: true, category: true },
            },
          },
        })
      ).json() as Envelope;
      expect(queried.errors ?? []).toEqual([]);
      expect(queried.data["swarm/SwarmConfig"]).toEqual([
        { id: row.id, key: "budget_default", value: "4000", category: "budget" },
      ]);
    } finally {
      await s.stop();
    }
  });
});

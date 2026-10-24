import { SWARM_META_TYPE_NAMES, SWARM_TYPE_NAMES } from "@mnmal-ai/swarm-substrate-shared";
import { describe, expect, it, vi } from "vitest";
import type { SubstrateSchema } from "../client.js";
import { ensureTypesRegistered } from "./ready.js";
import { SIDECAR_SPECS, type SidecarSpec } from "./specs.js";

const cold = SIDECAR_SPECS.find((s) => s.label === "cold") as SidecarSpec;
const meta = SIDECAR_SPECS.find((s) => s.label === "meta") as SidecarSpec;

const entries = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, { fields: {} }]));

/** What `/substrate/v1/schema/swarm` and `/swarm-docs` publish for a healthy cold sidecar. */
function coldSchema(): SubstrateSchema {
  return {
    namespaces: {
      swarm: {
        // Substrate publishes the custom query entries beside the types.
        types: entries([...SWARM_TYPE_NAMES, "loadContext", "classifyIntent", "prepareTask"]),
        queries: {},
        mutations: entries(["createSwarmConfig", "persistTaskTelemetry"]),
      },
      "swarm-docs": { types: entries(["Document", "Section"]), queries: {}, mutations: {} },
    },
  };
}

function metaSchema(): SubstrateSchema {
  return {
    namespaces: {
      swarm_meta: { types: entries(SWARM_META_TYPE_NAMES), queries: {}, mutations: {} },
    },
  };
}

function stubClient(schema: SubstrateSchema) {
  return { getSchema: vi.fn(async () => schema), invalidateSchema: vi.fn() };
}

describe("ensureTypesRegistered", () => {
  it("passes a cold sidecar that serves swarm, swarm-docs and the four custom ops", async () => {
    const client = stubClient(coldSchema());
    await expect(ensureTypesRegistered(client, [cold])).resolves.toBeUndefined();
    expect(client.invalidateSchema).toHaveBeenCalled();
    expect(client.getSchema).toHaveBeenCalled();
  });

  it("accepts the query ops under a queries bucket too", async () => {
    const schema = coldSchema();
    const swarm = schema.namespaces.swarm;
    for (const op of ["loadContext", "classifyIntent", "prepareTask"]) {
      delete swarm.types[op];
      swarm.queries[op] = {};
    }
    await expect(ensureTypesRegistered(stubClient(schema), [cold])).resolves.toBeUndefined();
  });

  it("ensureTypesRegistered fails naming the missing namespace or op", async () => {
    const noDocs = coldSchema();
    delete noDocs.namespaces["swarm-docs"];
    await expect(ensureTypesRegistered(stubClient(noDocs), [cold])).rejects.toThrow(/namespace 'swarm-docs'/);

    const noPrepare = coldSchema();
    delete noPrepare.namespaces.swarm.types.prepareTask;
    await expect(ensureTypesRegistered(stubClient(noPrepare), [cold])).rejects.toThrow(/prepareTask \(query\)/);

    // persistTaskTelemetry must be a mutation; a query of that name does not count.
    const wrongBucket = coldSchema();
    delete wrongBucket.namespaces.swarm.mutations.persistTaskTelemetry;
    wrongBucket.namespaces.swarm.queries.persistTaskTelemetry = {};
    await expect(ensureTypesRegistered(stubClient(wrongBucket), [cold])).rejects.toThrow(
      /persistTaskTelemetry \(mutation\)/,
    );

    const noMeta = metaSchema();
    delete noMeta.namespaces.swarm_meta;
    await expect(ensureTypesRegistered(stubClient(noMeta), [meta])).rejects.toThrow(/namespace 'swarm_meta'/);
  });

  it("names every missing type and the sidecar it checked", async () => {
    const schema = coldSchema();
    delete schema.namespaces.swarm.types.Observation;
    delete schema.namespaces.swarm.types.Goal;
    delete schema.namespaces["swarm-docs"].types.Section;
    const err = (await ensureTypesRegistered(stubClient(schema), [cold]).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/cold/);
    expect(err.message).toMatch(/Goal/);
    expect(err.message).toMatch(/Observation/);
    expect(err.message).toMatch(/swarm-docs\/Section/);
  });

  it("checks a meta sidecar against the meta types only", async () => {
    await expect(ensureTypesRegistered(stubClient(metaSchema()), [meta])).resolves.toBeUndefined();
    const missing = metaSchema();
    delete missing.namespaces.swarm_meta.types.BugReport;
    await expect(ensureTypesRegistered(stubClient(missing), [meta])).rejects.toThrow(/BugReport/);
  });

  it("names the namespace when getSchema itself fails", async () => {
    const client = {
      getSchema: vi.fn(async () => {
        throw new Error("Namespace 'swarm' not found at http://127.0.0.1:1: 404 Not Found");
      }),
      invalidateSchema: vi.fn(),
    };
    await expect(ensureTypesRegistered(client, [cold])).rejects.toThrow(/swarm/);
  });
});

/**
 * In-process Substrate server for the plugin's tests: the swarm plugin (plus
 * any extra coordinators) composed over memory datasets with the recall kernel
 * plugin, served by `MemorySubstrateServer` and driven through `inject()`. No
 * socket, no Postgres, no embedder service.
 *
 * Harness path: the `/recall` factory. `@mnmal-ai/substrate/recall` exports
 * `createRecallPlugin`, `InMemoryEmbeddingsStore` and `InMemoryClusterStore`,
 * so the kernel plugin is built directly, the way Substrate's own
 * cross-server-parity harness does (`buildRecallWiring` + `memoryHarness`). The
 * `loadPlugins`-against-a-temp-dir fallback was not needed.
 */
import {
  createRecallPlugin,
  InMemoryClusterStore,
  InMemoryEmbeddingsStore,
} from "@mnmal-ai/substrate/recall";
import type { CoordinatorPlugin, Dataset, EngineHandle } from "@mnmal-ai/substrate/sdk";
import {
  compose,
  FakeEmbedder,
  MemoryDataset,
  MemoryEdgesStore,
  MemorySubstrateServer,
} from "@mnmal-ai/substrate/testing";
import { type SwarmPluginConfig, createSwarmSubstratePlugin } from "../src/plugin.js";

/** Embedding dimension of the deterministic FakeEmbedder, unless a test asks for another. */
const DEFAULT_EMBEDDER_DIMENSION = 8;

export interface TestServerOptions {
  scope: SwarmPluginConfig["scope"];
  /** Extra coordinator plugins composed next to the swarm plugin. */
  coordinators?: CoordinatorPlugin[];
  embedderDimension?: number;
}

export interface TestResponse {
  status: number;
  json(): unknown;
}

export interface TestServer {
  inject(req: { method: "GET" | "POST"; url: string; body?: unknown }): Promise<TestResponse>;
  engine: EngineHandle;
  stop(): Promise<void>;
}

function bodyText(body: Buffer | Uint8Array | string | ReadableStream | undefined): string {
  if (body === undefined) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  throw new Error("test harness: streamed response bodies are not supported by json()");
}

export async function bootTestServer(opts: TestServerOptions): Promise<TestServer> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: "default" });
  const edges = new MemoryEdgesStore({ now: () => new Date() });

  // The embeddings store joins hits back to rows through the composed dataset
  // registry, which only exists after compose: bind it late.
  const datasetRegistry: { current: { get: (ns: string) => Dataset | undefined } | null } = {
    current: null,
  };
  const store = new InMemoryEmbeddingsStore({
    datasetFor: (ns) => datasetRegistry.current?.get(ns),
  });
  const embedder = new FakeEmbedder({
    dimension: opts.embedderDimension ?? DEFAULT_EMBEDDER_DIMENSION,
  });
  const recall = createRecallPlugin({
    store,
    edges,
    embedder,
    clusters: new InMemoryClusterStore(),
    // The binary wires this from engine.evaluateWritePolicy; without it the
    // mutating recall surfaces refuse to write. Auth is off in these tests.
    checkWritePolicy: () => ({ allow: true }),
  });

  const composed = await compose({
    // Auth is off, so the deployment must declare who it writes as.
    systemActor: "swarm-test",
    server,
    dataset,
    edges,
    coordinators: [createSwarmSubstratePlugin({ scope: opts.scope }), ...(opts.coordinators ?? [])],
    kernelPlugins: [recall],
  });
  datasetRegistry.current = composed.datasets;
  await server.start();

  return {
    engine: composed.engine,
    async inject(req) {
      const res = await server.inject({
        method: req.method,
        path: req.url,
        headers: { "content-type": "application/json" },
        body: req.body === undefined ? null : Buffer.from(JSON.stringify(req.body), "utf8"),
      });
      const text = bodyText(res.body);
      return {
        status: res.status,
        json: () => JSON.parse(text) as unknown,
      };
    },
    async stop() {
      await composed.stop();
    },
  };
}

import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    root: __dirname,
    include: ["**/*.test.ts"],
    testTimeout: 30000,
    // Isolate any real-sidecar (E2E) test from the live Substrate stack
    // (32337-32341). The setup does nothing unless SWARM_SDK_E2E=1; then it
    // spawns a private cold + meta `substrate serve` pair on the memory store
    // (or the alt-port docker stack with SWARM_SDK_PG=1) on ephemeral ports and
    // points this process, and only this process, at them. See
    // tests/setup/isolated-substrate.ts.
    globalSetup: [path.resolve(__dirname, "../setup/isolated-substrate.ts")],
  },
});

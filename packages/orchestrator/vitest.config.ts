import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30000,
    // Under SWARM_SDK_E2E=1 the setup spawns a private Substrate sidecar pair
    // for the run and points this process at it; otherwise it does nothing.
    globalSetup: ["../../tests/setup/isolated-substrate.ts"],
  },
});

# Integration tests

- `pnpm turbo test`: plain run; needs nothing beyond `node_modules` (no sidecar, no Ollama, no network).
- `SWARM_SDK_E2E=1`: also runs the suites that spawn private `substrate serve` sidecars (memory store, ephemeral ports; recall suites also need Ollama). Never spends money.
- `SWARM_SDK_CLAUDE=1`: separate opt-in for the paid suites (`permission-integration` spawns the `claude` CLI; `e2e-benchmark`, `e2e-oversight`, `e2e-retain-cycle` call the Anthropic API). Leave it unset unless you mean to pay.
- `e2e-benchmark` also needs `SWARM_PATH` pointing at a real swarm content directory: the repo fixture (`tests/fixtures/content`, two routes and three core files) is too small for it.

import { describe, it, expect } from "vitest";
import { ClaudeCodeBackend } from "@mnmal-ai/swarm-worker-backends";

// Paid: this suite spawns the claude CLI. It runs only with the separate opt-in
// SWARM_SDK_CLAUDE=1 (SWARM_SDK_E2E=1 alone never runs it); it needs no sidecar.
const RUN_CLAUDE = process.env.SWARM_SDK_CLAUDE === "1";

describe.skipIf(!RUN_CLAUDE)("ClaudeCodeBackend permission integration (paid; needs SWARM_SDK_CLAUDE=1)", () => {
  it("does not hang with acceptEdits mode on a simple task", async () => {
    const backend = new ClaudeCodeBackend({ type: "claude-code" });
    const available = await backend.isAvailable();
    if (!available) {
      console.log("Skipping: claude CLI not available");
      return;
    }

    // This should complete within 30s, not hang on permission prompts.
    const result = await Promise.race([
      backend.execute({
        task: "Say hello. Do not use any tools. Just respond with text.",
        workingDirectory: process.cwd(),
        swarmContext: "",
        maxTurns: 1,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out — likely hung on permission prompt")), 30_000)
      ),
    ]);

    expect(result.output).toBeTruthy();
    expect(result.backendUsed).toBe("claude-code");
  }, 35_000);
});

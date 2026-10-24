/**
 * Transcripts in sharing options
 *
 * Verifies the multiselect options array in init.ts contains
 * the "transcripts" sharing option with share_transcripts flag.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("init.ts sharing options include transcripts", () => {
  it("includes transcripts value in sharing multiselect options", async () => {
    const initSource = await readFile(
      join(import.meta.dirname, "../src/cli/init.ts"),
      "utf-8",
    );
    expect(initSource).toContain('value: "transcripts"');
  });

  it("references share_transcripts variable after selection", async () => {
    const initSource = await readFile(
      join(import.meta.dirname, "../src/cli/init.ts"),
      "utf-8",
    );
    expect(initSource).toContain("shareTranscripts");
  });

  it("assigns shareTranscripts from the transcripts selection", async () => {
    const initSource = await readFile(
      join(import.meta.dirname, "../src/cli/init.ts"),
      "utf-8",
    );
    // Verify the transcripts option drives the shareTranscripts variable
    expect(initSource).toContain('selected.includes("transcripts")');
  });

  it("writes share_transcripts to telemetry_sharing config", async () => {
    const initSource = await readFile(
      join(import.meta.dirname, "../src/cli/init.ts"),
      "utf-8",
    );
    expect(initSource).toContain("share_transcripts");
  });

  it("transcripts option has a descriptive hint about sensitive content", async () => {
    const initSource = await readFile(
      join(import.meta.dirname, "../src/cli/init.ts"),
      "utf-8",
    );
    // The hint should mention transcripts contain prompt/response content
    expect(initSource).toContain("Transcripts");
  });
});

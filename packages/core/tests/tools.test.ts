import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { executeTool } from "../src/index.js";

describe("executeTool — write_file", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-tools-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a clear error when content is undefined", async () => {
    const result = await executeTool(
      "write_file",
      { path: "test.txt", content: undefined },
      tmpDir,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("'content' parameter is missing or not a string");
    expect(result.content).toContain("undefined");
  });

  it("returns a clear error when content is null", async () => {
    const result = await executeTool(
      "write_file",
      { path: "test.txt", content: null },
      tmpDir,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("'content' parameter is missing or not a string");
    expect(result.content).toContain("object"); // typeof null === "object"
  });

  it("returns a clear error when content is a number", async () => {
    const result = await executeTool(
      "write_file",
      { path: "test.txt", content: 42 },
      tmpDir,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("'content' parameter is missing or not a string");
    expect(result.content).toContain("number");
  });

  it("writes a normal file successfully", async () => {
    const result = await executeTool(
      "write_file",
      { path: "hello.txt", content: "Hello, world!" },
      tmpDir,
    );

    expect(result.is_error).toBe(false);
    expect(result.content).toContain("Successfully wrote");

    const written = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf-8");
    expect(written).toBe("Hello, world!");
  });

  it("writes a large file (>20KB) successfully", async () => {
    const largeContent = "x".repeat(25 * 1024); // 25KB
    const result = await executeTool(
      "write_file",
      { path: "large.txt", content: largeContent },
      tmpDir,
    );

    expect(result.is_error).toBe(false);
    expect(result.content).toContain("Successfully wrote");

    const written = await fs.readFile(path.join(tmpDir, "large.txt"), "utf-8");
    expect(written.length).toBe(25 * 1024);
  });
});

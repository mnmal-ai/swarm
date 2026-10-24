/**
 * Ported from the previous engine package's `sections/embeddings.test.ts`
 * (`resolveEmbedderSettings` and `embed timeout`), with the variables renamed
 * to SWARM_EMBEDDER_* and the `kind` field added.
 */
import { describe, expect, it } from "vitest";
import { resolveEmbedderSettings, resolveOllamaUrl } from "./embedder-settings.js";

describe("resolveEmbedderSettings", () => {
  it("keeps today's default when nothing is set: nomic-embed-text at 768, no embedding on write", () => {
    expect(resolveEmbedderSettings({})).toEqual({ kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text", dimension: 768, timeoutMs: 15000, embedOnWrite: false });
  });

  it("knows bge-m3's dimension, and an explicit dimension wins", () => {
    expect(resolveEmbedderSettings({ SWARM_EMBEDDER_MODEL: "bge-m3" }).dimension).toBe(1024);
    expect(resolveEmbedderSettings({ SWARM_EMBEDDER_MODEL: "bge-m3:latest" }).dimension).toBe(1024);
    expect(resolveEmbedderSettings({ SWARM_EMBEDDER_MODEL: "my-model", SWARM_EMBEDDER_DIMENSION: "512" }).dimension).toBe(512);
  });

  it("turns on embedding on write only when swarm asks", () => {
    expect(resolveEmbedderSettings({ SWARM_EMBED_ON_WRITE: "1", SWARM_EMBEDDER_OLLAMA_URL: "http://127.0.0.1:11434" })).toMatchObject({ embedOnWrite: true, baseUrl: "http://127.0.0.1:11434" });
  });

  it("refuses a dimension that isn't a positive whole number, or a model it can't size", () => {
    expect(() => resolveEmbedderSettings({ SWARM_EMBEDDER_DIMENSION: "0" })).toThrow(/SWARM_EMBEDDER_DIMENSION/);
    expect(() => resolveEmbedderSettings({ SWARM_EMBEDDER_MODEL: "unknown-model", SWARM_EMBED_ON_WRITE: "1" })).toThrow(/SWARM_EMBEDDER_DIMENSION/);
  });

  it("takes SWARM_EMBEDDER_KIND none, and refuses any other kind", () => {
    expect(resolveEmbedderSettings({ SWARM_EMBEDDER_KIND: "none" }).kind).toBe("none");
    expect(resolveEmbedderSettings({ SWARM_EMBEDDER_KIND: "Ollama" }).kind).toBe("ollama");
    expect(() => resolveEmbedderSettings({ SWARM_EMBEDDER_KIND: "onnx" })).toThrow(/SWARM_EMBEDDER_KIND/);
    expect(resolveOllamaUrl({ SWARM_EMBEDDER_KIND: "none", SWARM_EMBEDDER_OLLAMA_URL: "http://gpu:11434" })).toBe("");
    expect(resolveOllamaUrl({ SWARM_EMBEDDER_OLLAMA_URL: "http://gpu:11434" })).toBe("http://gpu:11434");
  });
});

describe("embed timeout", () => {
  it("defaults to 15 s, takes SWARM_EMBEDDER_TIMEOUT_MS, and refuses nonsense", () => {
    expect(resolveEmbedderSettings({}).timeoutMs).toBe(15000);
    expect(resolveEmbedderSettings({ SWARM_EMBEDDER_TIMEOUT_MS: "8000" }).timeoutMs).toBe(8000);
    expect(() => resolveEmbedderSettings({ SWARM_EMBEDDER_TIMEOUT_MS: "soon" })).toThrow(/SWARM_EMBEDDER_TIMEOUT_MS/);
  });
});

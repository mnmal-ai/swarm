import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbedderSettings } from "../embedder-settings.js";
import { SIDECAR_SPECS, type SidecarSpec } from "./specs.js";
import { ensureStackDir, stackDirFor } from "./stacks.js";

const OLLAMA: EmbedderSettings = {
  kind: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "nomic-embed-text",
  dimension: 768,
  timeoutMs: 15_000,
  embedOnWrite: false,
};

const cold = SIDECAR_SPECS.find((s) => s.label === "cold") as SidecarSpec;
const meta = SIDECAR_SPECS.find((s) => s.label === "meta") as SidecarSpec;

describe("ensureStackDir", () => {
  let savedHome: string | undefined;
  let home: string;
  let runtimeDir: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "substrate-stacks-home-"));
    process.env.HOME = home;
    runtimeDir = join(home, ".swarm", "substrate", "runtime");
    mkdirSync(join(runtimeDir, "node_modules"), { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

  it("ensureStackDir writes package.json, swarm.config.json, recall config and the node_modules symlink", () => {
    const dir = ensureStackDir(cold, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });

    expect(dir).toBe(join(home, ".swarm", "substrate", "stacks", "cold"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readJson(join(dir, "package.json"))).toEqual({
      private: true,
      dependencies: {
        "@mnmal-ai/substrate": "*",
        "@mnmal-ai/swarm-substrate-plugin": "*",
        "@mnmal-ai/cortext": "*",
      },
    });
    expect(readJson(join(dir, "swarm.config.json"))).toEqual({
      scope: "cold",
      namespace: "swarm",
      contextNamespace: "cortext",
    });
    expect(readJson(join(dir, "substrate-recall.config.json"))).toEqual({
      embedder: { kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text", dimension: 768 },
      writeEmbedTimeoutMs: 120000,
      queryEmbedTimeoutMs: 15000,
    });
    // cortext's own default namespace is `cortext`, so it needs no config file.
    expect(existsSync(join(dir, "cortext.config.json"))).toBe(false);
    expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "node_modules"))).toBe(join(runtimeDir, "node_modules"));
  });

  it("cold stacks list cortext; meta stacks do not", () => {
    const coldDir = ensureStackDir(cold, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });
    const metaDir = ensureStackDir(meta, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });

    const deps = (dir: string) => Object.keys((readJson(join(dir, "package.json")) as { dependencies: object }).dependencies);
    expect(deps(coldDir)).toContain("@mnmal-ai/cortext");
    expect(deps(metaDir)).not.toContain("@mnmal-ai/cortext");
    expect(deps(metaDir).sort()).toEqual(["@mnmal-ai/substrate", "@mnmal-ai/swarm-substrate-plugin"]);
    expect(metaDir).toBe(join(home, ".swarm", "substrate", "stacks", "meta"));
    // The meta instance owns `<namespace>_meta`; its config names the base namespace.
    expect(readJson(join(metaDir, "swarm.config.json"))).toEqual({
      scope: "meta",
      namespace: "swarm",
      contextNamespace: "cortext",
    });
  });

  it("omits the recall config when the embedder kind is none, removing a stale one", () => {
    const dir = ensureStackDir(cold, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });
    expect(existsSync(join(dir, "substrate-recall.config.json"))).toBe(true);
    ensureStackDir(cold, { runtimeDir, embedder: { ...OLLAMA, kind: "none" }, contextNamespace: "cortext" });
    expect(existsSync(join(dir, "substrate-recall.config.json"))).toBe(false);
  });

  it("writes a cortext config only for a context namespace other than cortext's default", () => {
    const dir = ensureStackDir(cold, { runtimeDir, embedder: OLLAMA, contextNamespace: "claude" });
    expect(readJson(join(dir, "cortext.config.json"))).toEqual({ namespace: "claude" });
    expect((readJson(join(dir, "swarm.config.json")) as { contextNamespace: string }).contextNamespace).toBe("claude");
    ensureStackDir(cold, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });
    expect(existsSync(join(dir, "cortext.config.json"))).toBe(false);
  });

  it("puts a dedicated stack under <compose_project>-<label>", () => {
    const dedicated: SidecarSpec = { ...cold, port: 45002, stack: "swarm-project-a" };
    expect(stackDirFor(dedicated)).toBe(join(home, ".swarm", "substrate", "stacks", "swarm-project-a-cold"));
    const dir = ensureStackDir(dedicated, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });
    expect(dir).toBe(stackDirFor(dedicated));
    expect(existsSync(join(dir, "swarm.config.json"))).toBe(true);
  });

  it("refuses a stack name that is not a plain path segment", () => {
    for (const stack of ["../escape", "a/b", "", "with space", "proj;rm"]) {
      expect(() => stackDirFor({ label: "cold", stack }), stack).toThrow(/Invalid Substrate stack name/);
      expect(() => ensureStackDir({ ...cold, stack }, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" })).toThrow(
        /Invalid Substrate stack name/,
      );
    }
    expect(stackDirFor({ label: "meta", stack: "swarm-project_a.2" })).toBe(
      join(home, ".swarm", "substrate", "stacks", "swarm-project_a.2-meta"),
    );
  });

  it("is idempotent and repoints a node_modules symlink that names another runtime", () => {
    const dir = ensureStackDir(cold, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });
    const other = join(home, "other-runtime");
    mkdirSync(join(other, "node_modules"), { recursive: true });
    ensureStackDir(cold, { runtimeDir: other, embedder: OLLAMA, contextNamespace: "cortext" });
    expect(readlinkSync(join(dir, "node_modules"))).toBe(join(other, "node_modules"));
    ensureStackDir(cold, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });
    expect(readlinkSync(join(dir, "node_modules"))).toBe(join(runtimeDir, "node_modules"));
    writeFileSync(join(dir, "server.log"), "kept\n");
    ensureStackDir(cold, { runtimeDir, embedder: OLLAMA, contextNamespace: "cortext" });
    expect(readFileSync(join(dir, "server.log"), "utf8")).toBe("kept\n");
  });
});

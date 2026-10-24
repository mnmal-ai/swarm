/**
 * swarm run's side of fnl: the project's `fnl` block is checked at startup,
 * and when it's enabled swarm finds an fnl that supports what the worker hook
 * needs (`rewrite --deny` and `--check-invokes-fnl`) before any session uses
 * it. A missing or too-old fnl turns the integration off with one warning.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveFnl, validateFnlConfig } from "../src/cli/fnl-integration.js";
import { roleBackendConfigs } from "../src/cli/role-models.js";

describe("validateFnlConfig", () => {
  it("accepts no block and a full block", () => {
    expect(validateFnlConfig(undefined)).toEqual([]);
    expect(validateFnlConfig({ enabled: true, bin: "/opt/fnl/bin/fnl", wrap: ["make build", "./gradlew *"] })).toEqual([]);
  });

  it("names every problem", () => {
    expect(validateFnlConfig("yes")).toEqual([expect.stringContaining("fnl must be an object")]);
    const errors = validateFnlConfig({ enabled: "yes", bin: "", wrap: ["ok", "", "two\nlines", 3], extra: 1 });
    expect(errors).toEqual([
      expect.stringContaining("fnl.enabled"),
      expect.stringContaining("fnl.bin"),
      expect.stringContaining("fnl.wrap"),
      expect.stringContaining("fnl.extra is not a setting"),
    ]);
  });
});

describe("resolveFnl", () => {
  let dir: string;
  let good: string;
  let old: string;

  const script = (path: string, help: string, version = "0.7.0") => {
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = --help ]; then printf '%s\\n' "${help}"; exit 0; fi\nif [ "$1" = --version ]; then echo "${version}"; exit 0; fi\nexit 2\n`,
    );
    chmodSync(path, 0o755);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-fnl-resolve-"));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "old"));
    good = join(dir, "bin", "fnl");
    old = join(dir, "old", "fnl");
    script(good, "  fnl rewrite [--wrap P]… [--deny RULE]… [--check-invokes-fnl] [--] <command…>");
    script(old, "  fnl rewrite [--wrap P]… [--respect-claude-rules] [--] <command…>");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is off when the block is missing or not enabled", () => {
    expect(resolveFnl(undefined, { PATH: join(dir, "bin") })).toEqual({});
    expect(resolveFnl({ enabled: false }, { PATH: join(dir, "bin") })).toEqual({});
  });

  it("finds a supported fnl on PATH and carries the wrap patterns", () => {
    expect(resolveFnl({ enabled: true, wrap: ["make build"] }, { PATH: `/nonexistent:${join(dir, "bin")}` })).toMatchObject({
      fnl: { bin: good, wrap: ["make build"] },
    });
  });

  it("uses the configured bin", () => {
    expect(resolveFnl({ enabled: true, bin: good }, { PATH: "" })).toMatchObject({ fnl: { bin: good, wrap: [] } });
  });

  it("notes when fnl explains its decisions, so sessions count coverage, and reads its version", () => {
    const explaining = join(dir, "bin", "fnl-json");
    script(explaining, "  fnl rewrite [--json] [--wrap P]… [--deny RULE]… [--check-invokes-fnl] [--] <command…>", "0.8.0");
    const out = resolveFnl({ enabled: true, bin: explaining }, { PATH: "" });
    expect(out).toEqual({ fnl: { bin: explaining, wrap: [], json: true }, version: "0.8.0" });
  });

  it("keeps an fnl that can't explain its decisions, and warns that coverage isn't counted", () => {
    const out = resolveFnl({ enabled: true, bin: good }, { PATH: "" });
    expect(out.fnl).toEqual({ bin: good, wrap: [], json: false });
    expect(out.version).toBe("0.7.0");
    expect(out.warning).toMatch(/coverage isn't counted/);
    expect(out.warning).toMatch(/fnl upgrade/);
  });

  it("looks a bare bin up on PATH by the name configured, not as fnl", () => {
    mkdirSync(join(dir, "named"), { recursive: true });
    const named = join(dir, "named", "my-fnl");
    script(named, "  fnl rewrite [--wrap P]… [--deny RULE]… [--check-invokes-fnl] [--] <command…>");
    const PATH = `${join(dir, "bin")}:${join(dir, "named")}`;
    expect(resolveFnl({ enabled: true, bin: "my-fnl" }, { PATH })).toMatchObject({ fnl: { bin: named, wrap: [] } });
    const missing = resolveFnl({ enabled: true, bin: "other-fnl" }, { PATH });
    expect(missing.fnl).toBeUndefined();
    expect(missing.warning).toMatch(/isn't installed at other-fnl/);
  });

  it("resolves a relative bin against the directory swarm runs in", () => {
    expect(resolveFnl({ enabled: true, bin: relative(process.cwd(), good) }, { PATH: "" })).toMatchObject({ fnl: { bin: good, wrap: [] } });
  });

  it("turns off with a warning when fnl isn't installed", () => {
    const out = resolveFnl({ enabled: true }, { PATH: "/nonexistent" });
    expect(out.fnl).toBeUndefined();
    expect(out.warning).toMatch(/fnl isn't installed/);
  });

  it("turns off with a warning when fnl is too old for the worker hook", () => {
    const out = resolveFnl({ enabled: true, bin: old }, { PATH: "" });
    expect(out.fnl).toBeUndefined();
    expect(out.warning).toMatch(/too old/);
    expect(out.warning).toMatch(/fnl upgrade/);
  });
});

describe("roleBackendConfigs: fnl", () => {
  const FNL = { bin: "/opt/fnl/bin/fnl", wrap: ["make build"] };
  const SC = { strategy: "remote_pr" as const };

  it("gives every Claude Code role that runs Bash the resolved fnl", () => {
    const configs = roleBackendConfigs(
      { backends: { worker: { type: "claude-code" }, reviewer: { type: "claude-code" }, arbiter: { type: "api", fallback: "claude-code" } }, models: {}, source_control: SC },
      { fnl: FNL },
    );
    expect(configs.worker.fnl).toEqual(FNL);
    expect(configs.reviewer.fnl).toEqual(FNL);
    expect(configs.arbiter.fnl).toEqual(FNL);
  });

  it("carries whether fnl explains its decisions", () => {
    const configs = roleBackendConfigs(
      { backends: { worker: { type: "claude-code" } }, models: {}, source_control: SC },
      { fnl: { ...FNL, json: true } },
    );
    expect(configs.worker.fnl).toEqual({ ...FNL, json: true });
  });

  it("leaves out roles without Bash and API-only roles", () => {
    const configs = roleBackendConfigs(
      { backends: { worker: { type: "claude-code", tools: ["Read", "Edit"] } }, models: {}, source_control: SC },
      { fnl: FNL },
    );
    expect(configs.worker).not.toHaveProperty("fnl");
    expect(configs.reviewer).not.toHaveProperty("fnl");
  });

  it("adds nothing when swarm run found no fnl", () => {
    const configs = roleBackendConfigs({ backends: { worker: { type: "claude-code" } }, models: {}, source_control: SC });
    expect(configs.worker).not.toHaveProperty("fnl");
  });
});

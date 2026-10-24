import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Script-level tests for scripts/cold-test-env.sh
//
// The wrapper must run the given command with the alt-port test-stack
// variables, bringing the stack up only when it is not running. `docker` is a
// stub on PATH that records its arguments, so no container is touched.
// ---------------------------------------------------------------------------

const SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "cold-test-env.sh");
const PROBE =
  'printf "%s|%s|%s|%s|%s|%s" "$SWARM_SUBSTRATE_ENDPOINT" "$SWARM_SUBSTRATE_PORT" "$SWARM_SUBSTRATE_POSTGRES_URL" "$SWARM_META_ENDPOINT" "$SWARM_META_PORT" "$SWARM_META_POSTGRES_URL"';
const TEST_STACK = [
  "http://127.0.0.1:42338",
  "42338",
  "postgresql://swarm:swarm@localhost:42337/swarm",
  "http://127.0.0.1:42341",
  "42341",
  "postgresql://swarm:swarm@localhost:42340/swarm_meta",
].join("|");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-cold-test-env-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A `docker` that logs its arguments; `docker compose ps` prints a container id only when `running`. */
function stubDocker(running: boolean): void {
  const log = join(dir, "docker.log");
  writeFileSync(
    join(dir, "docker"),
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in *" ps "*) ${running ? 'echo "abc123"' : ":"} ;; esac\nexit 0\n`,
  );
  chmodSync(join(dir, "docker"), 0o755);
}

function run(args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf-8",
    // The live defaults in the caller's environment must not leak through.
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      SWARM_SUBSTRATE_PORT: "32338",
      SWARM_SUBSTRATE_ENDPOINT: "http://localhost:32338",
      SWARM_META_ENDPOINT: "http://localhost:32341",
    },
  });
}

describe("scripts/cold-test-env.sh", () => {
  it("runs the command with the test stack's variables, over the caller's live defaults", () => {
    stubDocker(true);
    const r = run(["sh", "-c", PROBE]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(TEST_STACK);
    // Already running: not brought up again.
    expect(readFileSync(join(dir, "docker.log"), "utf-8")).not.toContain(" up -d");
  });

  it("brings the stack up first when it is not running", () => {
    stubDocker(false);
    const r = run(["sh", "-c", PROBE]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(TEST_STACK);
    expect(readFileSync(join(dir, "docker.log"), "utf-8")).toContain(" up -d");
  });

  it("passes the command's arguments through untouched, a NAME=value first argument included", () => {
    stubDocker(true);
    const r = run(["A=1", "sh", "-c", "echo should-not-run"]);
    // `A=1` is the command, not an assignment: it does not exist, so nothing runs.
    expect(r.status).toBe(127);
    expect(r.stdout).toBe("");
  });

  it("refuses to run without a command", () => {
    stubDocker(true);
    const r = run([]);
    expect(r.status).toBe(64);
    expect(existsSync(join(dir, "docker.log"))).toBe(false);
  });
});

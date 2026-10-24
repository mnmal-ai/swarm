import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimProject } from "../src/cli/project-claim.js";

/**
 * `swarm merge` and `swarm run` share a project's work repo and checkpoint:
 * each claims the project while it runs, so they never overlap.
 */

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "swarm-claim-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = () => true;
const dead = () => false;

describe("claimProject", () => {
  it("refuses swarm merge while a live swarm run holds the project", async () => {
    const run = await claimProject(dir, "run", { pid: 100, isAlive: alive });
    expect(run.ok).toBe(true);
    const merge = await claimProject(dir, "merge", { pid: 200, isAlive: alive });
    expect(merge).toMatchObject({ ok: false, holder: { command: "run", pid: 100 } });
  });

  it("refuses swarm run while a live swarm merge holds the project", async () => {
    await claimProject(dir, "merge", { pid: 100, isAlive: alive });
    expect(await claimProject(dir, "run", { pid: 200, isAlive: alive })).toMatchObject({ ok: false, holder: { command: "merge" } });
  });

  it("takes a claim whose process has died", async () => {
    await claimProject(dir, "run", { pid: 100, isAlive: alive });
    expect((await claimProject(dir, "merge", { pid: 200, isAlive: dead })).ok).toBe(true);
  });

  it("releases only its own claim", async () => {
    const first = await claimProject(dir, "run", { pid: 100, isAlive: dead });
    const second = await claimProject(dir, "merge", { pid: 200, isAlive: dead });
    if (!first.ok || !second.ok) throw new Error("expected both claims");
    first.release();
    expect(existsSync(join(dir, "active.json"))).toBe(true);
    second.release();
    expect(existsSync(join(dir, "active.json"))).toBe(false);
  });
});

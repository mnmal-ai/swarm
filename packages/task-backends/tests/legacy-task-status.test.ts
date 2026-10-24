import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalTaskBackend } from "../src/local.js";
import { GitHubTaskBackend } from "../src/github.js";
import { cli } from "./helpers/fake-child-process.js";

// ---------------------------------------------------------------------------
// Budgets moved from dollars to tokens, and the two budget task statuses were
// renamed with them: `cost_exceeded` → `token_exceeded`, `skipped_cost` →
// `skipped_tokens`. Task state written before the rename must still load —
// as the new names — wherever a backend reads it, so resume, the dashboard
// and the run loop never see a status they don't know.
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async () => (await import("./helpers/fake-child-process.js")).fakeChildProcessModule());

const TEMP_DIR = join(__dirname, "__fixtures__", "legacy-task-status-test");

/** A tasks.json as a swarm from before the rename wrote it. */
const OLD_TASKS = [
  { id: "t-1", goal_id: "g-1", description: "Over its limit", intent: "implementation", status: "cost_exceeded", order: 1,
    result: { verdict: "approved", cost_usd: 1.25, latency_ms: 10, retry_count: 0 } },
  { id: "t-2", goal_id: "g-1", description: "Skipped for budget", intent: "implementation", status: "skipped_cost", order: 2 },
  { id: "t-3", goal_id: "g-1", description: "Done", intent: "implementation", status: "completed", order: 3 },
];

describe("legacy task statuses — local backend (tasks.json)", () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(join(TEMP_DIR, "tasks.json"), JSON.stringify(OLD_TASKS, null, 2));
  });

  afterEach(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it("loads an old record's statuses under their token names", async () => {
    const backend = new LocalTaskBackend(TEMP_DIR);

    const tasks = await backend.getTasks("g-1");

    expect(tasks.map((t) => t.status)).toEqual(["token_exceeded", "skipped_tokens", "completed"]);
  });

  it("maps them on every read path", async () => {
    const backend = new LocalTaskBackend(TEMP_DIR);

    expect((await backend.getAllTasks()).map((t) => t.status)).toEqual(["token_exceeded", "skipped_tokens", "completed"]);
    expect((await backend.getTaskById("t-1"))?.status).toBe("token_exceeded");
    expect((await backend.getTaskById("t-2"))?.status).toBe("skipped_tokens");
  });

  it("writes the new names back the next time it saves", async () => {
    const backend = new LocalTaskBackend(TEMP_DIR);

    await backend.updateTask("t-3", { description: "Done, and noted" });

    const saved = JSON.parse(readFileSync(join(TEMP_DIR, "tasks.json"), "utf-8")) as Array<{ status: string }>;
    expect(saved.map((t) => t.status)).toEqual(["token_exceeded", "skipped_tokens", "completed"]);
  });
});

describe("legacy task statuses — GitHub backend (issue metadata)", () => {
  beforeEach(() => {
    cli.mockReset();
  });

  function issue(number: number, status: string) {
    const metadata = { id: `t-${number}`, goal_id: "g-1", intent: "implementation", status, order: number };
    return {
      number,
      title: `Task ${number}`,
      body: ["<!-- swarm-metadata-start -->", "```json", JSON.stringify(metadata), "```", "<!-- swarm-metadata-end -->"].join("\n"),
      state: "OPEN",
    };
  }

  it("loads an old issue's status under its token name", async () => {
    cli.mockReturnValue(JSON.stringify([issue(1, "cost_exceeded"), issue(2, "skipped_cost"), issue(3, "pending")]));
    const backend = new GitHubTaskBackend("example-org/example-repo");

    const tasks = await backend.getTasks("g-1");

    expect(tasks.map((t) => t.status)).toEqual(["token_exceeded", "skipped_tokens", "pending"]);
  });

  it("maps a single task read too", async () => {
    cli.mockReturnValue(JSON.stringify(issue(2, "skipped_cost")));
    const backend = new GitHubTaskBackend("example-org/example-repo");

    expect((await backend.getTaskById("2"))?.status).toBe("skipped_tokens");
  });
});

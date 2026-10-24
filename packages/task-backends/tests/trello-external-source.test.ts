import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { execFile } from "node:child_process";
import { TrelloExternalSource } from "../src/trello-external-source.js";
import type { TrelloExternalSourceOptions } from "../src/trello-external-source.js";
import { cli, cliFailure, execFileCalls, fakeChild, type ExecFileCallback } from "./helpers/fake-child-process.js";

// ---------------------------------------------------------------------------
// Mock the child_process module so no Trello CLI ever runs; `cli` plays it
// ---------------------------------------------------------------------------

vi.mock("node:child_process", async () => (await import("./helpers/fake-child-process.js")).fakeChildProcessModule());

const mockExecFile = execFile as unknown as Mock;

function resetCli(): void {
  cli.mockReset();
  mockExecFile.mockClear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMMAND = ["node", "./bin/trello-cli.mjs"];

function makeSource(overrides: Partial<TrelloExternalSourceOptions> = {}): TrelloExternalSource {
  return new TrelloExternalSource({
    command: COMMAND,
    cwd: "/repo",
    boards: ["board-a"],
    ...overrides,
  });
}

const CARD_DESC = [
  "## Summary",
  "",
  "Saved searches do not appear on the dashboard.",
  "",
  "## Details",
  "",
  "**Viewers**",
  "- see every saved search",
].join("\n");

function summary(shortLink: string, name: string, board = "board-a") {
  return {
    id: `id-${shortLink}`,
    url: `https://trello.com/c/${shortLink}`,
    board,
    name,
    labels: ["area:search", "type:feature"],
    list: "To Do",
  };
}

function detail(shortLink: string, name: string, board = "board-a") {
  return {
    ...summary(shortLink, name, board),
    desc: CARD_DESC,
    checklists: [
      { name: "Notes", items: [{ name: "not acceptance", done: false }] },
      {
        name: "Acceptance",
        items: [
          { name: "A viewer sees every saved search", done: false },
          { name: "The test suite passes", done: true },
        ],
      },
    ],
    comments: [],
  };
}

/** Route CLI calls by subcommand: `cards <board>` and `show <card>`. */
function routeCli(boards: Record<string, ReturnType<typeof summary>[]>) {
  cli.mockImplementation((_file, args) => {
    const [, sub, target] = args;
    if (sub === "cards") return JSON.stringify(boards[target] ?? []);
    if (sub === "show") {
      const all = Object.values(boards).flat();
      const card = all.find((c) => c.id === target || c.url.endsWith(`/${target}`));
      return JSON.stringify(detail(card!.url.split("/").pop()!, card!.name, card!.board));
    }
    return "{}";
  });
}

/**
 * The argv of every CLI call made so far, starting at the subcommand. execFile
 * receives `(file, args)` where `file` is COMMAND[0] and `args` begins with the
 * rest of COMMAND, so the first `COMMAND.length - 1` args are the script path.
 */
function cliCalls(): string[][] {
  return execFileCalls(mockExecFile).map((call) => call.args.slice(COMMAND.length - 1));
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("TrelloExternalSource — construction", () => {
  it("requires a command", () => {
    expect(() => makeSource({ command: [] })).toThrow(/command/);
  });

  it("requires at least one board", () => {
    expect(() => makeSource({ boards: [] })).toThrow(/board/);
  });

  it("names itself trello", () => {
    expect(makeSource().name).toBe("trello");
  });
});

// ---------------------------------------------------------------------------
// fetchItems
// ---------------------------------------------------------------------------

describe("TrelloExternalSource — fetchItems", () => {
  beforeEach(() => {
    resetCli();
  });

  it("runs the CLI in the configured directory, with a 30 s timeout", async () => {
    routeCli({ "board-a": [summary("aaa111", "Show saved searches on the dashboard")] });

    await makeSource().fetchItems();

    const [{ file, args, options }] = execFileCalls(mockExecFile);
    expect(file).toBe("node");
    expect(args).toEqual(["./bin/trello-cli.mjs", "cards", "board-a", "--list", "To Do"]);
    expect(options).toMatchObject({ cwd: "/repo", timeout: 30_000 });
  });

  it("takes only the top card of each board's queue by default", async () => {
    routeCli({
      "board-a": [summary("aaa111", "First"), summary("bbb222", "Second")],
      "board-b": [summary("ccc333", "Third", "board-b")],
    });

    const items = await makeSource({ boards: ["board-a", "board-b"] }).fetchItems();

    expect(items.map((i) => i.title)).toEqual(["First", "Third"]);
  });

  it("takes more cards per board when asked", async () => {
    routeCli({ "board-a": [summary("aaa111", "First"), summary("bbb222", "Second"), summary("ddd444", "Fourth")] });

    const items = await makeSource({ perBoard: 2 }).fetchItems();

    expect(items.map((i) => i.title)).toEqual(["First", "Second"]);
  });

  it("reads from a different queue column when configured", async () => {
    routeCli({ "board-a": [] });

    await makeSource({ queueList: "Ready" }).fetchItems();

    expect(cliCalls()[0]).toEqual(["cards", "board-a", "--list", "Ready"]);
  });

  it("identifies each card by its short link and keeps its URL and labels", async () => {
    routeCli({ "board-a": [summary("aaa111", "First")] });

    const [item] = await makeSource().fetchItems();

    expect(item.externalId).toBe("aaa111");
    expect(item.url).toBe("https://trello.com/c/aaa111");
    expect(item.labels).toEqual(["area:search", "type:feature"]);
    expect(item.state).toBe("open");
  });

  it("carries the description and the Acceptance checklist in the body", async () => {
    routeCli({ "board-a": [summary("aaa111", "First")] });

    const [item] = await makeSource().fetchItems();

    expect(item.body).toContain("Saved searches do not appear on the dashboard.");
    expect(item.body).toContain("## Acceptance\n- [ ] A viewer sees every saved search\n- [x] The test suite passes");
    expect(item.body).not.toContain("not acceptance");
  });

  it("surfaces the CLI's own error message when it refuses", async () => {
    cli.mockImplementation(() => {
      throw cliFailure("error: that card is not on a configured board; refusing to touch it\n");
    });

    await expect(makeSource().fetchItems()).rejects.toThrow(
      "Trello CLI failed (cards): error: that card is not on a configured board; refusing to touch it",
    );
  });
});

// ---------------------------------------------------------------------------
// parseGoal / fetchGoals
// ---------------------------------------------------------------------------

describe("TrelloExternalSource — parseGoal", () => {
  beforeEach(() => {
    resetCli();
  });

  it("maps a card to a pending goal keyed by its short link", async () => {
    routeCli({ "board-a": [summary("aaa111", "Show saved searches on the dashboard")] });
    const source = makeSource();
    const [item] = await source.fetchItems();

    const goal = source.parseGoal(item);

    expect(goal.id).toBe("trello-aaa111");
    expect(goal.description).toBe("Show saved searches on the dashboard");
    expect(goal.status).toBe("pending");
    expect(goal.constraints).toEqual([]);
    expect(goal.url).toBe("https://trello.com/c/aaa111");
    // Kept for source_control.merge_prs.skip_labels.
    expect(goal.labels).toEqual(["area:search", "type:feature"]);
  });

  it("takes acceptance criteria from the Acceptance checklist", async () => {
    routeCli({ "board-a": [summary("aaa111", "First")] });
    const source = makeSource();
    const [item] = await source.fetchItems();

    expect(source.parseGoal(item).acceptance_criteria).toEqual([
      "A viewer sees every saved search",
      "The test suite passes",
    ]);
  });

  it("keeps the whole card description as goal context, with the card URL", async () => {
    routeCli({ "board-a": [summary("aaa111", "First")] });
    const source = makeSource();
    const [item] = await source.fetchItems();

    const goal = source.parseGoal(item);

    expect(goal.context).toContain("Card: https://trello.com/c/aaa111");
    expect(goal.context).toContain("**Viewers**\n- see every saved search");
    expect(goal.context).not.toContain("## Acceptance");
  });

  it("sets no dependencies, because a card in the queue is unblocked by definition", async () => {
    routeCli({ "board-a": [summary("aaa111", "First")] });
    const source = makeSource();
    const [item] = await source.fetchItems();

    expect(source.parseGoal(item).dependsOn).toBeUndefined();
  });

  it("orders goals by board, then by position in the column", async () => {
    routeCli({
      "board-a": [summary("aaa111", "A1"), summary("bbb222", "A2")],
      "board-b": [summary("ccc333", "B1", "board-b")],
    });

    const goals = await makeSource({ boards: ["board-a", "board-b"], perBoard: 2 }).fetchGoals();

    expect(goals.map((g) => [g.description, g.priority])).toEqual([
      ["A1", 0],
      ["A2", 1],
      ["B1", 2],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("TrelloExternalSource — updateStatus", () => {
  beforeEach(() => {
    resetCli();
    cli.mockReturnValue("{}");
  });

  it.each([
    ["in_progress", "Doing"],
    ["completed", "Review"],
    ["failed", "Blocked"],
    ["merged", "Done"],
  ] as const)("moves the card to the %s column (%s)", async (status, list) => {
    await makeSource().updateStatus("aaa111", status);

    expect(cliCalls()).toEqual([["update", "aaa111", "--list", list]]);
  });

  it("leaves the card where it is for pending", async () => {
    await makeSource().updateStatus("aaa111", "pending");

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("uses configured column names", async () => {
    await makeSource({ lists: { completed: "Ready for QA" } }).updateStatus("aaa111", "completed");

    expect(cliCalls()).toEqual([["update", "aaa111", "--list", "Ready for QA"]]);
  });
});

describe("TrelloExternalSource — postComment", () => {
  beforeEach(() => {
    resetCli();
    cli.mockReturnValue("{}");
  });

  it("marks every comment as written by an agent", async () => {
    await makeSource().postComment("aaa111", "Started.");

    expect(cliCalls()).toEqual([["comment", "aaa111", "--text", "[agent] Started."]]);
  });

  it("does not mark a comment twice", async () => {
    await makeSource().postComment("aaa111", "[agent] Started.");

    expect(cliCalls()).toEqual([["comment", "aaa111", "--text", "[agent] Started."]]);
  });
});

// ---------------------------------------------------------------------------
// How the CLI process is run
// ---------------------------------------------------------------------------

describe("TrelloExternalSource — running the CLI", () => {
  beforeEach(() => {
    resetCli();
    cli.mockReturnValue("{}");
  });

  it("runs it without a shell: argv reaches the CLI verbatim, and stdin is closed", async () => {
    const text = `it's "done" $(touch pwned) \`id\`; rm -rf ~ && echo $HOME | cat > out`;

    await makeSource().postComment("aaa111", text);

    const [call] = execFileCalls(mockExecFile);
    expect(call.file).toBe("node");
    expect(call.args).toEqual(["./bin/trello-cli.mjs", "comment", "aaa111", "--text", `[agent] ${text}`]);
    expect(call.options.shell).toBeFalsy();
    expect(call.stdinClosed).toBe(true);
    expect(call.stdin).toBeUndefined();
  });

  it("does not block the event loop while the CLI runs", async () => {
    let exit: (() => void) | undefined;
    mockExecFile.mockImplementationOnce((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      exit = () => callback(null, "{}", "");
      return fakeChild();
    });
    const order: string[] = [];

    const update = makeSource().updateStatus("aaa111", "completed").then(() => order.push("CLI finished"));

    // The CLI has started and the caller has control back: a timer gets to run.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setTimeout(() => (order.push("timer"), resolve()), 0));
    expect(order).toEqual(["timer"]);

    // The call settles only when the CLI exits.
    exit!();
    await update;
    expect(order).toEqual(["timer", "CLI finished"]);
  });
});

describe("TrelloExternalSource — creating cards", () => {
  it("refuses to create goal cards", async () => {
    await expect(
      makeSource().pushGoal({ id: "g", description: "x", priority: 0, status: "pending", constraints: [], acceptance_criteria: [] }),
    ).rejects.toThrow(/does not create cards/);
  });

  it("refuses to create task cards", async () => {
    await expect(
      makeSource().pushTask({ id: "t", goal_id: "g", description: "x", intent: "implement", status: "pending", order: 1 }, "aaa111"),
    ).rejects.toThrow(/does not create cards/);
  });
});

describe("TrelloExternalSource — returnToQueue", () => {
  beforeEach(() => {
    resetCli();
    cli.mockReturnValue("{}");
  });

  it("moves the card back to the column swarm takes work from", async () => {
    await makeSource().returnToQueue("aaa111");

    expect(cliCalls()).toEqual([["update", "aaa111", "--list", "To Do"]]);
  });

  it("uses the configured queue column", async () => {
    await makeSource({ queueList: "Ready" }).returnToQueue("aaa111");

    expect(cliCalls()).toEqual([["update", "aaa111", "--list", "Ready"]]);
  });
});

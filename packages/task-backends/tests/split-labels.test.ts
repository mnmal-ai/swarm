/**
 * A ticket's `swarm_split: true` / `swarm_split: false` label overrides the
 * project's decomposition policy for that goal. Both external sources read it
 * into Goal.split; a ticket with both labels gets false, flagged so swarm run
 * can warn.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExternalItem } from "@mnmal-ai/swarm-types";
import { splitFromLabels } from "../src/labels.js";
import { GitHubExternalSource } from "../src/github-external-source.js";
import { TrelloExternalSource } from "../src/trello-external-source.js";
import { cli } from "./helpers/fake-child-process.js";

vi.mock("node:child_process", async () => (await import("./helpers/fake-child-process.js")).fakeChildProcessModule());

describe("splitFromLabels", () => {
  it("reads swarm_split: true and swarm_split: false", () => {
    expect(splitFromLabels(["area:members", "swarm_split: true"])).toEqual({ split: true, conflict: false });
    expect(splitFromLabels(["swarm_split: false", "type:bug"])).toEqual({ split: false, conflict: false });
  });

  it("matches case-insensitively, with or without whitespace around the colon", () => {
    for (const label of ["swarm_split:false", "swarm_split : false", "Swarm_Split: FALSE", "  SWARM_SPLIT:False  ", "swarm_split\t:\tfalse"]) {
      expect(splitFromLabels([label]).split).toBe(false);
    }
    for (const label of ["swarm_split:true", "SWARM_SPLIT : TRUE"]) {
      expect(splitFromLabels([label]).split).toBe(true);
    }
  });

  it("ignores other labels and other values", () => {
    for (const labels of [[], ["area:members", "type:bug", "severity:high"], ["swarm_split: yes"], ["swarm_split"], ["swarm split: false"], ["no swarm_split: false"], ["swarm_split: falsey"]]) {
      expect(splitFromLabels(labels)).toEqual({ split: undefined, conflict: false });
    }
  });

  it("lets false win, and flags the conflict, when both are present", () => {
    expect(splitFromLabels(["swarm_split: true", "swarm_split: false"])).toEqual({ split: false, conflict: true });
    expect(splitFromLabels(["swarm_split:FALSE", "Swarm_Split : true"])).toEqual({ split: false, conflict: true });
  });
});

function githubItem(labels: string[]): ExternalItem {
  return {
    externalId: "12",
    title: "Hold queue shows the wrong position",
    body: "## Acceptance Criteria\n- [ ] Position matches the queue",
    state: "open",
    labels,
    url: "https://github.com/example/sample-project/issues/12",
  };
}

describe("GitHubExternalSource — split from labels", () => {
  const source = new GitHubExternalSource({ repo: "example/sample-project" });

  it("sets split from a swarm_split label", () => {
    expect(source.parseGoal(githubItem(["swarm:goal", "swarm_split: false"])).split).toBe(false);
    expect(source.parseGoal(githubItem(["swarm:goal", "swarm_split:true"])).split).toBe(true);
  });

  it("leaves split unset without one", () => {
    const goal = source.parseGoal(githubItem(["swarm:goal", "priority:2"]));
    expect(goal.split).toBeUndefined();
    expect("split" in goal).toBe(false);
    expect(goal.splitConflict).toBeUndefined();
  });

  it("flags both labels as a conflict and uses false", () => {
    const goal = source.parseGoal(githubItem(["swarm_split: true", "swarm_split: false"]));
    expect(goal.split).toBe(false);
    expect(goal.splitConflict).toBe(true);
  });
});

describe("TrelloExternalSource — split from card labels", () => {
  beforeEach(() => {
    cli.mockReset();
  });

  function routeCard(labels: string[]): void {
    const card = {
      id: "id-kq7Lm2Pa",
      url: "https://trello.com/c/kq7Lm2Pa",
      board: "board-a",
      name: "Add barcode labels for new copies",
      labels,
      list: "To Do",
    };
    cli.mockImplementation((_file, args) => {
      const sub = args[1];
      if (sub === "cards") return JSON.stringify([card]);
      if (sub === "show") return JSON.stringify({ ...card, desc: "## Summary\n\nNo labels yet.", checklists: [] });
      return "{}";
    });
  }

  const source = () => new TrelloExternalSource({ command: ["node", "./bin/trello-cli.mjs"], boards: ["board-a"] });

  it("sets split from a card's swarm_split label", async () => {
    routeCard(["area:catalogue", "type:feature", "swarm_split: false"]);
    const [goal] = await source().fetchGoals();
    expect(goal.split).toBe(false);
    expect(goal.splitConflict).toBeUndefined();

    routeCard(["type:feature", "milestone:next", "Swarm_Split:TRUE"]);
    expect((await source().fetchGoals())[0].split).toBe(true);
  });

  it("leaves split unset on a card without one", async () => {
    routeCard(["area:catalogue", "type:feature"]);
    const [goal] = await source().fetchGoals();
    expect("split" in goal).toBe(false);
  });

  it("flags both labels as a conflict and uses false", async () => {
    routeCard(["area:catalogue", "swarm_split: true", "swarm_split: false"]);
    const [goal] = await source().fetchGoals();
    expect(goal).toMatchObject({ split: false, splitConflict: true });
  });
});

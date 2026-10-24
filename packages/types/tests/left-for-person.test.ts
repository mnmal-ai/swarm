import { describe, expect, it } from "vitest";
import { addLeftForPerson, countLeftForPerson } from "../src/left-for-person.js";

describe("addLeftForPerson", () => {
  it("groups items by task, in the order they arrive", () => {
    let groups = addLeftForPerson([], "Build the settings screen", ["Check it on a phone"]);
    groups = addLeftForPerson(groups, "Wire the API", ["Add the production key"]);
    groups = addLeftForPerson(groups, "Build the settings screen", ["Review the copy"]);
    expect(groups).toEqual([
      { task: "Build the settings screen", items: ["Check it on a phone", "Review the copy"] },
      { task: "Wire the API", items: ["Add the production key"] },
    ]);
  });

  it("lists an item once across the goal, ignoring case and spacing", () => {
    let groups = addLeftForPerson([], "Task A", ["Check it on a phone", "check it  on a PHONE"]);
    groups = addLeftForPerson(groups, "Task B", ["Check it on a phone.", "Check it on a phone"]);
    expect(groups).toEqual([
      { task: "Task A", items: ["Check it on a phone"] },
      { task: "Task B", items: ["Check it on a phone."] },
    ]);
  });

  it("adds no group for a task with nothing new, and leaves its input alone", () => {
    const before = addLeftForPerson([], "Task A", ["One"]);
    const after = addLeftForPerson(before, "Task B", ["one", "  ", ""]);
    expect(after).toEqual([{ task: "Task A", items: ["One"] }]);
    expect(before).toEqual([{ task: "Task A", items: ["One"] }]);
  });

  it("counts items", () => {
    expect(countLeftForPerson(undefined)).toBe(0);
    expect(countLeftForPerson([{ task: "A", items: ["1", "2"] }, { task: "B", items: ["3"] }])).toBe(3);
  });
});

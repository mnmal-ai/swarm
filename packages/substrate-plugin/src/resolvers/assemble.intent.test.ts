import { describe, expect, it } from "vitest";
import { filterByIntent } from "./assemble.js";

type Entity = Parameters<typeof filterByIntent>[0][number];

const skill = (path: string, intent: string): Entity =>
  ({ id: path, path, tier: "skills_vetted", intent, content: path, tokenEstimate: 10 }) as unknown as Entity;

describe("filterByIntent", () => {
  it("keeps a skill whose intent is \"all\" on every route", () => {
    const entities = [skill("skills/vetted/a.md", "all")];
    for (const intent of ["implementation", "code-review", "orchestration"]) {
      expect(filterByIntent(entities, intent)).toHaveLength(1);
    }
  });

  it("still keeps a skill with an empty intent and drops one listed for other intents", () => {
    const entities = [skill("skills/vetted/empty.md", ""), skill("skills/vetted/review.md", "code-review")];
    expect(filterByIntent(entities, "implementation").map((e) => e.path)).toEqual(["skills/vetted/empty.md"]);
  });

  it("keeps a skill listed for several intents when the route's is one of them", () => {
    const entities = [skill("skills/vetted/both.md", "implementation, code-review")];
    expect(filterByIntent(entities, "code-review")).toHaveLength(1);
  });
});

import { describe, it, expect } from "vitest";
import { parseDecompositionOutput } from "../src/cli/run.js";

describe("parseDecompositionOutput", () => {
  describe("object format with shared_files", () => {
    it("parses object format and injects shared_files into modifies", () => {
      const output = JSON.stringify({
        shared_files: ["src/routes/index.ts", "src/app.ts"],
        tasks: [
          { title: "Add auth", description: "Create auth module", intent: "implementation", creates: ["src/auth.ts"], modifies: [] },
          { title: "Add users", description: "Create users module", intent: "implementation", creates: ["src/users.ts"], modifies: ["src/db.ts"] },
        ],
      });

      const result = parseDecompositionOutput(output);
      expect(result).not.toBeNull();
      expect(result!.sharedFiles).toEqual(["src/routes/index.ts", "src/app.ts"]);
      expect(result!.tasks).toHaveLength(2);
      // shared_files injected into both tasks' modifies
      expect(result!.tasks[0].modifies).toContain("src/routes/index.ts");
      expect(result!.tasks[0].modifies).toContain("src/app.ts");
      expect(result!.tasks[1].modifies).toContain("src/routes/index.ts");
      expect(result!.tasks[1].modifies).toContain("src/app.ts");
      // existing modifies preserved
      expect(result!.tasks[1].modifies).toContain("src/db.ts");
    });

    it("deduplicates shared_files already in modifies", () => {
      const output = JSON.stringify({
        shared_files: ["src/index.ts"],
        tasks: [
          { title: "Task 1", description: "Do something", intent: "implementation", modifies: ["src/index.ts", "src/other.ts"] },
        ],
      });

      const result = parseDecompositionOutput(output);
      expect(result).not.toBeNull();
      const modifies = result!.tasks[0].modifies!;
      const indexCount = modifies.filter(f => f === "src/index.ts").length;
      expect(indexCount).toBe(1);
    });

    it("handles empty shared_files array", () => {
      const output = JSON.stringify({
        shared_files: [],
        tasks: [
          { title: "Task 1", description: "Do something", intent: "implementation", modifies: ["src/a.ts"] },
        ],
      });

      const result = parseDecompositionOutput(output);
      expect(result).not.toBeNull();
      expect(result!.sharedFiles).toEqual([]);
      expect(result!.tasks[0].modifies).toEqual(["src/a.ts"]);
    });

    it("filters non-string entries from shared_files", () => {
      const output = JSON.stringify({
        shared_files: ["src/valid.ts", 123, null, "src/also-valid.ts"],
        tasks: [
          { title: "Task 1", description: "Do something", intent: "implementation", modifies: [] },
        ],
      });

      const result = parseDecompositionOutput(output);
      expect(result).not.toBeNull();
      expect(result!.sharedFiles).toEqual(["src/valid.ts", "src/also-valid.ts"]);
    });
  });

  describe("legacy array format", () => {
    it("parses array format with no shared_files", () => {
      const output = JSON.stringify([
        { title: "Task 1", description: "Do thing 1", intent: "implementation", creates: ["src/a.ts"], modifies: ["src/index.ts"] },
        { title: "Task 2", description: "Do thing 2", intent: "implementation", creates: [], modifies: ["src/b.ts"] },
      ]);

      const result = parseDecompositionOutput(output);
      expect(result).not.toBeNull();
      expect(result!.sharedFiles).toEqual([]);
      expect(result!.tasks).toHaveLength(2);
      expect(result!.tasks[0].modifies).toEqual(["src/index.ts"]);
    });
  });

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      expect(parseDecompositionOutput("")).toBeNull();
    });

    it("returns null for text with no JSON", () => {
      expect(parseDecompositionOutput("Here is my analysis of the codebase...")).toBeNull();
    });

    it("returns null for unrecognized JSON format (plain object without tasks)", () => {
      expect(parseDecompositionOutput(JSON.stringify({ foo: "bar" }))).toBeNull();
    });

    it("returns null for empty task array", () => {
      expect(parseDecompositionOutput(JSON.stringify({ shared_files: [], tasks: [] }))).toBeNull();
      expect(parseDecompositionOutput("[]")).toBeNull();
    });

    it("filters out tasks without description", () => {
      const output = JSON.stringify([
        { title: "No desc", intent: "implementation" },
        { title: "Has desc", description: "Valid task", intent: "implementation" },
      ]);

      const result = parseDecompositionOutput(output);
      expect(result).not.toBeNull();
      expect(result!.tasks).toHaveLength(1);
      expect(result!.tasks[0].title).toBe("Has desc");
    });

    it("extracts JSON from surrounding text", () => {
      const output = `Here is the decomposition:\n\`\`\`json\n${JSON.stringify({
        shared_files: ["src/app.ts"],
        tasks: [{ title: "Task", description: "Do it", intent: "implementation" }],
      })}\n\`\`\`\nDone!`;

      const result = parseDecompositionOutput(output);
      expect(result).not.toBeNull();
      expect(result!.tasks).toHaveLength(1);
      expect(result!.sharedFiles).toEqual(["src/app.ts"]);
    });
  });
});

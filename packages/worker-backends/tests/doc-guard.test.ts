/**
 * The read guard for indexed documents (stage 2 of the context-sections
 * spec): a Read or Bash call that reads several sections of an indexed
 * document, and more than the limit, is refused with the document's outline;
 * every other call runs, and the session's reads are counted.
 *
 * The fixture is an invented guide of three sections: a short start, a setup
 * section, and one 6,000-token table that can't be split.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DocumentGuard } from "@mnmal-ai/swarm-types";
import { DocumentReadCounter, decideDocumentRead, documentGuardPreToolUse, outline } from "../src/doc-guard.js";

const CWD = "/work/acme";
const GUIDE = `${CWD}/docs/guide.md`;
const SMALL = `${CWD}/docs/small.md`;
const DATA = `${CWD}/docs/data.txt`;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const tokensOf = (lines: string[]) => Math.ceil(lines.join("\n").length / 4);

const intro = ["# Guide", "", "What the guide is for.", ...Array.from({ length: 9 }, () => "intro text ".repeat(10).trim())];
const setup = ["## Setup", "", "Which tools to install.", ...Array.from({ length: 30 }, () => "setup text ".repeat(10).trim())];
const table = ["## Reference", "", "| key | value |", "| --- | --- |", ...Array.from({ length: 240 }, (_, i) => `| ${"k".repeat(40)}${i} | ${"v".repeat(50)} |`)];
const lines = [...intro, ...setup, ...table];
const guideText = lines.join("\n");

// L1–12, L13–45, L46–289.
const ranges = [
  [1, intro.length],
  [intro.length + 1, intro.length + setup.length],
  [intro.length + setup.length + 1, lines.length],
] as const;

const smallText = "# Small\nA small document.\n## Part\nIts only part.";

const guard: DocumentGuard = {
  maxReadTokens: 4000,
  documents: [
    {
      absolutePath: GUIDE,
      displayPath: "docs/guide.md",
      contentHash: sha(guideText),
      sections: [
        { startLine: ranges[0][0], endLine: ranges[0][1], headingPath: [], synopsis: "What the guide is for.", tokens: tokensOf(intro) },
        { startLine: ranges[1][0], endLine: ranges[1][1], headingPath: ["Setup"], synopsis: "Which tools to install.", tokens: tokensOf(setup) },
        { startLine: ranges[2][0], endLine: ranges[2][1], headingPath: ["Reference"], synopsis: "Every setting, in one table.", tokens: tokensOf(table) },
      ],
    },
    {
      absolutePath: SMALL,
      displayPath: "docs/small.md",
      contentHash: sha(smallText),
      sections: [
        { startLine: 1, endLine: 2, headingPath: [], synopsis: "A small document.", tokens: 7 },
        { startLine: 3, endLine: 4, headingPath: ["Part"], synopsis: "Its only part.", tokens: 6 },
      ],
    },
    {
      absolutePath: DATA,
      displayPath: "docs/data.txt",
      contentHash: "",
      sections: [
        { startLine: 1, endLine: 1, headingPath: [], synopsis: "", tokens: 1 },
        { startLine: 2, endLine: 2, headingPath: ["B"], synopsis: "", tokens: 1 },
      ],
    },
  ],
};

const files: Record<string, string> = { [GUIDE]: guideText, [SMALL]: smallText, [DATA]: guideText };
const readFile = (p: string) => files[p] ?? null;

const decide = (toolName: string, toolInput: Record<string, unknown>, opts: { read?: (p: string) => string | null; cwd?: string } = {}) => {
  const reads = new DocumentReadCounter();
  const decision = decideDocumentRead(guard, toolName, toolInput, opts.cwd ?? CWD, opts.read ?? readFile, reads);
  return { decision, reads: reads.snapshot() };
};

const fmt = (n: number) => n.toLocaleString("en-US");
const guideTokens = tokensOf(intro) + tokensOf(setup) + tokensOf(table);

describe("decideDocumentRead: Read", () => {
  it("refuses an unbounded Read, giving every section's range and synopsis", () => {
    expect(tokensOf(table)).toBeGreaterThan(5000);
    const { decision, reads } = decide("Read", { file_path: GUIDE });
    expect(decision).toEqual({
      refuse: true,
      reason: [
        `docs/guide.md is stored by section (${fmt(guideTokens)} tok, 3 sections). Read only the sections you need, with offset and limit:`,
        `- L1–12 (start) (${fmt(tokensOf(intro))} tok) — What the guide is for.`,
        `- L13–45 Setup (${fmt(tokensOf(setup))} tok) — Which tools to install.`,
        `- L46–289 Reference (${fmt(tokensOf(table))} tok) — Every setting, in one table.`,
      ].join("\n"),
    });
    expect(reads).toEqual({ bounded: 0, refused: 1, whole: 0, ranges: [] });
  });

  it("allows a Read of one section's exact range, and counts it as bounded", () => {
    const { decision, reads } = decide("Read", { file_path: GUIDE, offset: 13, limit: 33 });
    expect(decision).toEqual({ refuse: false });
    expect(reads).toEqual({ bounded: 1, refused: 0, whole: 0, ranges: [{ path: "docs/guide.md", startLine: 13, endLine: 45 }] });
  });

  it("allows reading the big table section alone, however big it is", () => {
    const { decision, reads } = decide("Read", { file_path: GUIDE, offset: 46, limit: 244 });
    expect(decision).toEqual({ refuse: false });
    expect(reads.bounded).toBe(1);
  });

  it("refuses a range spanning two sections over the limit, and allows one under it", () => {
    expect(decide("Read", { file_path: GUIDE, offset: 13, limit: 200 }).decision.refuse).toBe(true);
    const under = decide("Read", { file_path: GUIDE, offset: 1, limit: 45 });
    expect(under.decision).toEqual({ refuse: false });
    expect(under.reads.ranges).toEqual([{ path: "docs/guide.md", startLine: 1, endLine: 45 }]);
  });

  it("allows a small document read whole, and counts it as whole", () => {
    const { decision, reads } = decide("Read", { file_path: SMALL });
    expect(decision).toEqual({ refuse: false });
    expect(reads).toEqual({ bounded: 0, refused: 0, whole: 1, ranges: [{ path: "docs/small.md", startLine: 1, endLine: 4 }] });
  });

  it("matches the document however its path is spelled", () => {
    for (const file_path of [GUIDE, "./docs/guide.md", "docs/../docs/guide.md", "docs/guide.md"]) {
      expect(decide("Read", { file_path }).decision.refuse, file_path).toBe(true);
    }
    expect(decide("Read", { file_path: "guide.md" }, { cwd: `${CWD}/docs` }).decision.refuse).toBe(true);
  });
});

describe("decideDocumentRead: Bash", () => {
  it.each([
    "cat docs/guide.md",
    "cd docs && cat guide.md",
    "less ./docs/guide.md",
    "sed -n '1,400p' docs/guide.md",
    `cat ${GUIDE}`,
    "git status; cat -n docs/guide.md",
    "tail -n 270 docs/guide.md",
  ])("refuses %s", (command) => {
    const { decision, reads } = decide("Bash", { command });
    expect(decision.refuse).toBe(true);
    expect(reads.refused).toBe(1);
  });

  it.each(["cat docs/guide.md | grep x", "grep -n x docs/guide.md", "head -20 docs/guide.md", "cat docs/guide.md > /tmp/copy.md", "echo $(cat docs/guide.md)", "sed -n 50p docs/guide.md"])(
    "allows %s",
    (command) => {
      expect(decide("Bash", { command }).decision).toEqual({ refuse: false });
    },
  );

  it("counts a bounded Bash read with its lines", () => {
    expect(decide("Bash", { command: "head -n 20 docs/guide.md" }).reads.ranges).toEqual([{ path: "docs/guide.md", startLine: 1, endLine: 20 }]);
    expect(decide("Bash", { command: "sed -n '13,45p' docs/guide.md" }).reads.ranges).toEqual([{ path: "docs/guide.md", startLine: 13, endLine: 45 }]);
  });
});

describe("decideDocumentRead: a document that changed after the sync", () => {
  it("refuses a whole read with ranges from the headings as they are now, and no synopses", () => {
    const edited = ["# Guide", "New first line.", ...lines.slice(1, intro.length), "## Added", "added text", ...setup, ...table].join("\n");
    const { decision } = decide("Read", { file_path: GUIDE }, { read: (p) => (p === GUIDE ? edited : null) });
    const editedLines = edited.split("\n");
    const at = (heading: string) => editedLines.indexOf(heading) + 1;
    expect(decision.refuse).toBe(true);
    const reason = decision.refuse ? decision.reason : "";
    expect(reason.split("\n").slice(1)).toEqual([
      `- L1–${at("## Added") - 1} (start) (${fmt(tokensOf(editedLines.slice(0, at("## Added") - 1)))} tok)`,
      `- L${at("## Added")}–${at("## Setup") - 1} Added (${fmt(tokensOf(editedLines.slice(at("## Added") - 1, at("## Setup") - 1)))} tok)`,
      `- L${at("## Setup")}–${at("## Reference") - 1} Setup (${fmt(tokensOf(editedLines.slice(at("## Setup") - 1, at("## Reference") - 1)))} tok)`,
      `- L${at("## Reference")}–${editedLines.length} Reference (${fmt(tokensOf(editedLines.slice(at("## Reference") - 1)))} tok)`,
    ]);
  });
});

describe("decideDocumentRead: what it leaves alone", () => {
  it("allows, and counts nothing for, a guarded file that's gone, a path not in the guard, and a non-markdown file", () => {
    for (const [toolInput, read] of [
      [{ file_path: GUIDE }, () => null],
      [{ file_path: `${CWD}/docs/other.md` }, readFile],
      [{ file_path: DATA }, readFile],
    ] as const) {
      const { decision, reads } = decide("Read", toolInput, { read });
      expect(decision).toEqual({ refuse: false });
      expect(reads).toEqual({ bounded: 0, refused: 0, whole: 0, ranges: [] });
    }
  });

  it("allows the call when reading the file throws", () => {
    const { decision, reads } = decide("Read", { file_path: GUIDE }, {
      read: () => {
        throw new Error("EACCES");
      },
    });
    expect(decision).toEqual({ refuse: false });
    expect(reads.refused).toBe(0);
  });

  it("ignores other tools", () => {
    expect(decide("Grep", { pattern: "x", path: GUIDE }).decision).toEqual({ refuse: false });
  });
});

describe("outline", () => {
  it("uses the stored sections while the hash matches", () => {
    expect(outline(guideText, guard.documents[0])[1]).toBe(`- L13–45 Setup (${fmt(tokensOf(setup))} tok) — Which tools to install.`);
  });

  it("ignores headings inside a code fence when the hash differs", () => {
    const text = ["## One", "```md", "## Not a heading", "```", "### Two", "text"].join("\n");
    expect(outline(text, guard.documents[0]).map((l) => l.split(" (")[0])).toEqual(["- L1–4 One", "- L5–6 One › Two"]);
  });
});

describe("DocumentReadCounter", () => {
  it("keeps at most 50 ranges", () => {
    const counter = new DocumentReadCounter();
    for (let i = 1; i <= 60; i++) counter.add("bounded", { path: "docs/guide.md", startLine: i, endLine: i });
    const snap = counter.snapshot();
    expect(snap.bounded).toBe(60);
    expect(snap.ranges).toHaveLength(50);
  });
});

describe("documentGuardPreToolUse", () => {
  const signal = new AbortController().signal;

  it("denies a refused call with the outline as the reason, and returns nothing otherwise", async () => {
    const reads = new DocumentReadCounter();
    const hook = documentGuardPreToolUse({ guard, cwd: "/elsewhere", reads, readFile });
    const denied = await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "docs/guide.md" }, cwd: CWD }, "t1", { signal });
    expect(denied).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("docs/guide.md is stored by section") },
    });
    const allowed = await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: GUIDE, offset: 13, limit: 33 }, cwd: CWD }, "t2", { signal });
    expect(allowed).toEqual({});
    expect(reads.snapshot()).toMatchObject({ bounded: 1, refused: 1 });
  });

  it("matches a document reached through a symlinked folder, either way round", async () => {
    // macOS /tmp is a symlink to /private/tmp: a session's cwd comes back as
    // the real path while the guard may hold the linked one, or the reverse.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "swarm-doc-guard-link-")));
    try {
      mkdirSync(join(root, "real", "docs"), { recursive: true });
      writeFileSync(join(root, "real", "docs", "guide.md"), guideText);
      symlinkSync(join(root, "real"), join(root, "link"));
      const viaLink: DocumentGuard = { ...guard, documents: [{ ...guard.documents[0], absolutePath: join(root, "link", "docs", "guide.md") }] };
      const viaReal: DocumentGuard = { ...guard, documents: [{ ...guard.documents[0], absolutePath: join(root, "real", "docs", "guide.md") }] };
      for (const [g, cwd] of [
        [viaLink, join(root, "real")],
        [viaReal, join(root, "link")],
      ] as const) {
        const reads = new DocumentReadCounter();
        const hook = documentGuardPreToolUse({ guard: g, reads });
        const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(cwd, "docs", "guide.md") }, cwd }, "t1", { signal });
        expect(out).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
        expect(reads.snapshot().refused).toBe(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to its own cwd when the hook input has none", async () => {
    const reads = new DocumentReadCounter();
    const hook = documentGuardPreToolUse({ guard, cwd: CWD, reads, readFile });
    const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cat docs/guide.md" } }, "t1", { signal });
    expect(out).toHaveProperty("hookSpecificOutput.permissionDecision", "deny");
  });
});

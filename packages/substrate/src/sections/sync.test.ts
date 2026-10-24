import { describe, expect, it } from "vitest";
import {
  type DocsStore,
  type SectionRecord,
  type StoredDocument,
  type SynopsisRequest,
  type SynopsisWriter,
  substrateDocsStore,
  syncDocuments,
} from "./sync.js";

/** An in-memory DocsStore, so sync's decisions can be checked row by row. */
class MemoryDocsStore implements DocsStore {
  documents: StoredDocument[] = [];
  sections: SectionRecord[] = [];
  #next = 0;
  readonly calls: string[] = [];

  async listDocuments(projectId: string) {
    return this.documents.filter((d) => d.projectId === projectId);
  }
  async listSections(projectId: string) {
    return this.sections.filter((s) => s.projectId === projectId);
  }
  async createDocument(doc: Omit<StoredDocument, "id">) {
    const id = `d${this.#next++}`;
    this.documents.push({ ...doc, id });
    this.calls.push(`createDocument ${doc.path}`);
    return id;
  }
  async updateDocument(id: string, patch: Partial<Omit<StoredDocument, "id">>) {
    const doc = this.documents.find((d) => d.id === id);
    if (!doc) throw new Error(`no document ${id}`);
    Object.assign(doc, patch);
    this.calls.push(`updateDocument ${doc.path}`);
  }
  async deleteDocument(id: string) {
    const doc = this.documents.find((d) => d.id === id);
    this.documents = this.documents.filter((d) => d.id !== id);
    this.calls.push(`deleteDocument ${doc?.path}`);
  }
  async createSections(rows: Omit<SectionRecord, "id">[]) {
    for (const row of rows) this.sections.push({ ...row, id: `s${this.#next++}` });
    this.calls.push(`createSections ${rows.length}`);
  }
  async deleteSections(ids: string[]) {
    this.sections = this.sections.filter((s) => !ids.includes(s.id));
    this.calls.push(`deleteSections ${ids.length}`);
  }
}

/** A writer that records each request and names each section by its heading. */
class FakeWriter implements SynopsisWriter {
  readonly requests: SynopsisRequest[] = [];
  constructor(private readonly fail = false) {}
  async write(req: SynopsisRequest): Promise<string[]> {
    this.requests.push(req);
    if (this.fail) throw new Error("model unavailable");
    return req.sections.map((s) => `model: ${s.headingPath.join(" › ") || "start"}`);
  }
}

const para = (word: string, tokens = 150) => `${`${word} `.repeat(Math.ceil((tokens * 4) / (word.length + 1)))}`.trim();
const doc = (...sections: Array<[string, string]>) => sections.map(([h, w]) => `## ${h}\n${para(w)}`).join("\n");

describe("syncDocuments", () => {
  it("stores a new file as a Document and its Sections, with one model call for the file", async () => {
    const store = new MemoryDocsStore();
    const writer = new FakeWriter();
    const report = await syncDocuments(store, [{ path: "docs/api.md", source: "project", content: `# API\n${doc(["Errors", "err"], ["Retries", "retry"])}` }], {
      projectId: "acme",
      sources: ["project"],
      writer,
      commit: "abc123",
    });
    expect(store.documents).toEqual([expect.objectContaining({ projectId: "acme", path: "docs/api.md", source: "project", title: "API", commit: "abc123" })]);
    expect(store.sections.map((s) => [s.path, s.ordinal, JSON.parse(s.headingPath), s.synopsis])).toEqual([
      ["docs/api.md", 0, ["Errors"], "model: Errors"],
      ["docs/api.md", 1, ["Retries"], "model: Retries"],
    ]);
    expect(store.sections.every((s) => s.document === store.documents[0].id && s.projectId === "acme" && s.source === "project")).toBe(true);
    expect(writer.requests).toHaveLength(1);
    expect(writer.requests[0].sections).toHaveLength(2);
    expect(report.documents).toEqual({ created: 1, updated: 0, unchanged: 0, deleted: 0 });
    expect(report.synopses).toEqual({ model: 2, override: 0, fallback: 0, cached: 0 });
  });

  it("skips a file whose content hasn't changed", async () => {
    const store = new MemoryDocsStore();
    const files = [{ path: "docs/a.md", source: "project" as const, content: doc(["One", "one"]) }];
    await syncDocuments(store, files, { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    store.calls.length = 0;
    const writer = new FakeWriter();
    const report = await syncDocuments(store, files, { projectId: "acme", sources: ["project"], writer });
    expect(store.calls).toEqual([]);
    expect(writer.requests).toEqual([]);
    expect(report.documents.unchanged).toBe(1);
  });

  it("re-splits a changed file, reusing synopses of sections whose text didn't change", async () => {
    const store = new MemoryDocsStore();
    await syncDocuments(store, [{ path: "docs/a.md", source: "project", content: doc(["One", "one"], ["Two", "two"]) }], {
      projectId: "acme",
      sources: ["project"],
      writer: new FakeWriter(),
    });
    const writer = new FakeWriter();
    const report = await syncDocuments(store, [{ path: "docs/a.md", source: "project", content: doc(["One", "one"], ["Two", "changed"]) }], {
      projectId: "acme",
      sources: ["project"],
      writer,
    });
    expect(writer.requests).toHaveLength(1);
    expect(writer.requests[0].sections.map((s) => s.headingPath)).toEqual([["Two"]]);
    expect(store.sections.map((s) => s.synopsis)).toEqual(["model: One", "model: Two"]);
    expect(store.documents).toHaveLength(1);
    expect(report.documents.updated).toBe(1);
    expect(report.synopses).toEqual({ model: 1, override: 0, fallback: 0, cached: 1 });
  });

  it("uses a writer's own synopsis comment, and calls no model when every section has one", async () => {
    const store = new MemoryDocsStore();
    const writer = new FakeWriter();
    const content = `## Errors\n<!-- synopsis: How errors are shaped. -->\n${para("err")}`;
    await syncDocuments(store, [{ path: "docs/a.md", source: "project", content }], { projectId: "acme", sources: ["project"], writer });
    expect(store.sections[0].synopsis).toBe("How errors are shaped.");
    expect(writer.requests).toEqual([]);
  });

  it("falls back to the first sentence when the model call fails, or there is no writer", async () => {
    for (const writer of [new FakeWriter(true), undefined]) {
      const store = new MemoryDocsStore();
      const errors: string[] = [];
      const content = `## Errors\nErrors carry a code. ${para("err")}`;
      const report = await syncDocuments(store, [{ path: "docs/a.md", source: "project", content }], {
        projectId: "acme",
        sources: ["project"],
        writer,
        log: (m) => errors.push(m),
      });
      expect(store.sections[0].synopsis).toBe("Errors carry a code.");
      expect(report.synopses.fallback).toBe(1);
      if (writer) expect(errors.join("\n")).toContain("model unavailable");
    }
  });

  it("falls back for sections a model answer doesn't cover", async () => {
    const store = new MemoryDocsStore();
    const short: SynopsisWriter = { write: async () => ["only one"] };
    await syncDocuments(store, [{ path: "docs/a.md", source: "project", content: `## One\nFirst thing. ${para("x")}\n## Two\nSecond thing. ${para("y")}` }], {
      projectId: "acme",
      sources: ["project"],
      writer: short,
    });
    expect(store.sections.map((s) => s.synopsis)).toEqual(["only one", "Second thing."]);
  });

  it("deletes the Document and Sections of a file that is gone, only among the sources synced", async () => {
    const store = new MemoryDocsStore();
    await syncDocuments(
      store,
      [
        { path: "docs/gone.md", source: "project", content: doc(["A", "a"]) },
        { path: "core/rules.md", source: "swarm", content: doc(["B", "b"]) },
      ],
      { projectId: "acme", sources: ["project", "swarm"], writer: new FakeWriter() },
    );
    const report = await syncDocuments(store, [], { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    expect(store.documents.map((d) => d.path)).toEqual(["core/rules.md"]);
    expect(store.sections.map((s) => s.path)).toEqual(["core/rules.md"]);
    expect(report.documents.deleted).toBe(1);
  });

  it("never touches another project's rows", async () => {
    const store = new MemoryDocsStore();
    await syncDocuments(store, [{ path: "docs/a.md", source: "project", content: doc(["A", "a"]) }], { projectId: "other", sources: ["project"], writer: new FakeWriter() });
    await syncDocuments(store, [], { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    expect(store.documents.map((d) => d.projectId)).toEqual(["other"]);
  });

  it("stores an empty file as a Document with no sections", async () => {
    const store = new MemoryDocsStore();
    await syncDocuments(store, [{ path: "docs/empty.md", source: "project", content: "" }], { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    expect(store.documents).toHaveLength(1);
    expect(store.sections).toEqual([]);
  });

  it("keeps going when one file fails to store, and reports it", async () => {
    const store = new MemoryDocsStore();
    const original = store.createDocument.bind(store);
    store.createDocument = async (d) => {
      if (d.path === "docs/bad.md") throw new Error("write refused");
      return original(d);
    };
    const report = await syncDocuments(
      store,
      [
        { path: "docs/bad.md", source: "project", content: doc(["A", "a"]) },
        { path: "docs/good.md", source: "project", content: doc(["B", "b"]) },
      ],
      { projectId: "acme", sources: ["project"], writer: new FakeWriter() },
    );
    expect(store.documents.map((d) => d.path)).toEqual(["docs/good.md"]);
    expect(report.errors).toEqual([expect.stringContaining("docs/bad.md")]);
  });
});

describe("syncDocuments: progress and concurrency", () => {
  /** A writer that answers after `ms`, recording how many calls were in flight at once. */
  class SlowWriter implements SynopsisWriter {
    inFlight = 0;
    maxInFlight = 0;
    constructor(private readonly ms = 20) {}
    async write(req: SynopsisRequest): Promise<string[]> {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      await new Promise((r) => setTimeout(r, this.ms));
      this.inFlight--;
      return req.sections.map(() => "slow synopsis");
    }
  }
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `docs/f${i}.md`, source: "project" as const, content: doc([`H${i}`, `w${i}`]) }));

  it("reports counts only: how many files changed, each one finished, and the end", async () => {
    const store = new MemoryDocsStore();
    const events: Array<Record<string, unknown>> = [];
    await syncDocuments(store, files(3), { projectId: "acme", sources: ["project"], writer: new FakeWriter(), onProgress: (p) => events.push({ ...p }) });
    const sizes = files(3).map((f) => Buffer.byteLength(f.content, "utf8"));
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(events[0]).toEqual({ phase: "start", changedFiles: 3, totalFiles: 3, changedBytes: total });
    const steps = events.filter((e) => e.phase === "progress");
    expect(steps.map((e) => [e.done, e.total, e.bytesTotal])).toEqual([[1, 3, total], [2, 3, total], [3, 3, total]]);
    // Text is counted as files finish, in whatever order they finish: each
    // step adds one file's size, and together they add up to the total.
    const added = steps.map((e, i) => (e.bytesDone as number) - (i === 0 ? 0 : (steps[i - 1].bytesDone as number)));
    expect([...added].sort((a, b) => a - b)).toEqual([...sizes].sort((a, b) => a - b));
    const done = events.at(-1)!;
    expect(done).toMatchObject({ phase: "done", done: 3, total: 3, bytesDone: total, bytesTotal: total, failures: 0 });
    expect(typeof done.ms).toBe("number");
    // Nothing but numbers and the phase name: no paths or text.
    for (const e of events) for (const [k, v] of Object.entries(e)) if (k !== "phase") expect(typeof v, k).toBe("number");
  });

  it("reports no work for files that haven't changed", async () => {
    const store = new MemoryDocsStore();
    await syncDocuments(store, files(2), { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    const events: Array<Record<string, unknown>> = [];
    await syncDocuments(store, files(2), { projectId: "acme", sources: ["project"], writer: new FakeWriter(), onProgress: (p) => events.push({ ...p }) });
    expect(events[0]).toEqual({ phase: "start", changedFiles: 0, totalFiles: 2, changedBytes: 0 });
    expect(events.filter((e) => e.phase === "progress")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ phase: "done", done: 0, total: 0 });
  });

  it("writes several files' synopses at once, four by default, and one at a time when asked", async () => {
    const parallel = new SlowWriter();
    await syncDocuments(new MemoryDocsStore(), files(8), { projectId: "acme", sources: ["project"], writer: parallel });
    expect(parallel.maxInFlight).toBe(4);
    const serial = new SlowWriter();
    await syncDocuments(new MemoryDocsStore(), files(4), { projectId: "acme", sources: ["project"], writer: serial, concurrency: 1 });
    expect(serial.maxInFlight).toBe(1);
  });

  it("still stores every other file, and counts the failure, when one fails among parallel files", async () => {
    const store = new MemoryDocsStore();
    const original = store.createSections.bind(store);
    store.createSections = async (rows) => {
      if (rows[0]?.path === "docs/f2.md") throw new Error("write refused");
      return original(rows);
    };
    const events: Array<Record<string, unknown>> = [];
    const report = await syncDocuments(store, files(6), { projectId: "acme", sources: ["project"], writer: new SlowWriter(5), onProgress: (p) => events.push({ ...p }) });
    expect(report.errors).toEqual([expect.stringContaining("docs/f2.md")]);
    // The failed file keeps no sections and its Document no hash, so it loads whole and is retried.
    expect(store.sections.some((s) => s.path === "docs/f2.md")).toBe(false);
    expect(store.documents.find((d) => d.path === "docs/f2.md")?.contentHash ?? "").toBe("");
    expect(store.sections.filter((s) => s.path !== "docs/f2.md")).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ phase: "done", done: 6, total: 6, failures: 1 });
  });
});

describe("syncDocuments: large files", () => {
  /** Records each call's sections; fails the calls whose index is listed. */
  class BatchWriter implements SynopsisWriter {
    readonly calls: SynopsisRequest[] = [];
    constructor(private readonly failCalls: number[] = []) {}
    async write(req: SynopsisRequest): Promise<string[]> {
      const n = this.calls.push(req) - 1;
      if (this.failCalls.includes(n)) throw new Error("Claude Code process aborted by user");
      return req.sections.map((s) => `model: ${s.headingPath.join(" › ")}`);
    }
  }
  // 30 sections of about 5 KB each: a 150 KB file, too much for one call.
  const big = { path: "docs/big.md", source: "project" as const, content: `# Big\n${Array.from({ length: 30 }, (_, i) => `## S${i}\n${para(`s${i}`, 1300)}`).join("\n")}` };

  it("writes a large file's synopses in batches of about 48 KB, so no one call is huge", async () => {
    const writer = new BatchWriter();
    const store = new MemoryDocsStore();
    await syncDocuments(store, [big], { projectId: "acme", sources: ["project"], writer });
    expect(writer.calls.length).toBeGreaterThan(2);
    for (const call of writer.calls) {
      const bytes = call.sections.reduce((n, s) => n + Buffer.byteLength(s.body, "utf8"), 0);
      expect(bytes).toBeLessThanOrEqual(48 * 1024);
    }
    expect(writer.calls.flatMap((c) => c.sections).length).toBe(store.sections.length);
    expect(store.sections.every((s) => s.synopsis.startsWith("model: "))).toBe(true);
  });

  it("falls back to first sentences only for a batch that fails, and counts the fallbacks", async () => {
    const writer = new BatchWriter([1]);
    const store = new MemoryDocsStore();
    const events: Array<Record<string, unknown>> = [];
    const report = await syncDocuments(store, [big], { projectId: "acme", sources: ["project"], writer, onProgress: (p) => events.push({ ...p }) });
    const failed = writer.calls[1].sections.length;
    expect(report.synopses.fallback).toBe(failed);
    expect(store.sections.filter((s) => !s.synopsis.startsWith("model: "))).toHaveLength(failed);
    expect(events.at(-1)).toMatchObject({ phase: "done", fallbacks: failed });
  });
});

describe("substrateDocsStore", () => {
  it("reads and writes the swarm-docs types through the client, scoped to the project", async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const client = {
      query: async (type: string, params: Record<string, unknown>) => {
        calls.push(["query", type, params]);
        if (type === "Document") {
          return [
            { id: "d1", projectId: "acme", path: "docs/a.md", source: "project", title: "A", contentHash: "h", commit: null },
            { id: "d2", projectId: "other", path: "docs/b.md", source: "project", title: "B", contentHash: "h", commit: null },
          ];
        }
        return [{ id: "s1", document: "d1", projectId: "acme", path: "docs/a.md", source: "swarm", headingPath: "[]", ordinal: 2, level: 0, synopsis: "x", tokens: 7, contentHash: "c" }];
      },
      mutate: async (name: string, params: Record<string, unknown>) => {
        calls.push(["mutate", name, params]);
        return name === "createDocument" ? { id: "new-doc" } : { id: "x" };
      },
    } as unknown as import("../client.js").SubstrateClient;
    const store = substrateDocsStore(client);

    expect((await store.listDocuments("acme")).map((d) => d.id)).toEqual(["d1"]);
    expect(await store.listSections("acme")).toEqual([expect.objectContaining({ id: "s1", source: "swarm", ordinal: 2, tokens: 7 })]);
    expect(calls.filter(([k]) => k === "query").map(([, , p]) => p)).toEqual([
      { where: { projectId: { eq: "acme" } } },
      { where: { projectId: { eq: "acme" } } },
    ]);
    expect(await store.createDocument({ projectId: "acme", path: "p", source: "project", title: "t", contentHash: "h", commit: null })).toBe("new-doc");
    await store.deleteSections(["s1", "s2"]);
    expect(calls.filter(([, n]) => n === "deleteSection").map(([, , p]) => p)).toEqual([{ id: "s1" }, { id: "s2" }]);
  });
});

describe("syncDocuments: a failure part way through", () => {
  /** A store whose createSections fails after writing `after` rows, once. */
  function flaky(after: number) {
    const store = new MemoryDocsStore();
    const original = store.createSections.bind(store);
    let armed = false;
    return {
      store,
      arm: () => {
        armed = true;
      },
      install: () => {
        store.createSections = async (rows) => {
          if (!armed) return original(rows);
          armed = false;
          await original(rows.slice(0, after));
          throw new Error("write refused part way");
        };
      },
    };
  }

  it("keeps the old version whole when writing a changed file's sections fails, and repairs it next time", async () => {
    const f = flaky(1);
    f.install();
    const v1 = doc(["One", "one"], ["Two", "two"]);
    const v2 = doc(["One", "uno"], ["Two", "dos"]);
    await syncDocuments(f.store, [{ path: "docs/a.md", source: "project", content: v1 }], { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    const oldHash = f.store.documents[0].contentHash;
    const oldIds = f.store.sections.map((s) => s.id).sort();

    f.arm();
    const failed = await syncDocuments(f.store, [{ path: "docs/a.md", source: "project", content: v2 }], { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    expect(failed.errors).toHaveLength(1);
    expect(f.store.documents[0].contentHash).toBe(oldHash);
    expect(f.store.sections.map((s) => s.id).sort()).toEqual(oldIds);
    expect(f.store.sections.every((s) => s.documentHash === oldHash)).toBe(true);

    const repaired = await syncDocuments(f.store, [{ path: "docs/a.md", source: "project", content: v2 }], { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    expect(repaired.documents.updated).toBe(1);
    expect(f.store.sections.map((s) => s.body.split("\n")[1].split(" ")[0])).toEqual(["uno", "dos"]);
    expect(f.store.sections.every((s) => s.documentHash === f.store.documents[0].contentHash)).toBe(true);
  });

  it("leaves a new file pending, with no sections, when its sections fail, and finishes it next time", async () => {
    const f = flaky(1);
    f.install();
    f.arm();
    const content = doc(["One", "one"], ["Two", "two"]);
    await syncDocuments(f.store, [{ path: "docs/a.md", source: "project", content }], { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    expect(f.store.documents).toEqual([expect.objectContaining({ contentHash: "" })]);
    expect(f.store.sections).toEqual([]);
    await syncDocuments(f.store, [{ path: "docs/a.md", source: "project", content }], { projectId: "acme", sources: ["project"], writer: new FakeWriter() });
    expect(f.store.sections).toHaveLength(2);
    expect(f.store.documents[0].contentHash).not.toBe("");
  });

  it("caps a model's synopsis at 160 characters", async () => {
    const store = new MemoryDocsStore();
    const long: SynopsisWriter = { write: async (req) => req.sections.map(() => "word ".repeat(80)) };
    await syncDocuments(store, [{ path: "docs/a.md", source: "project", content: doc(["One", "one"]) }], { projectId: "acme", sources: ["project"], writer: long });
    expect(store.sections[0].synopsis.length).toBeLessThanOrEqual(160);
  });
});

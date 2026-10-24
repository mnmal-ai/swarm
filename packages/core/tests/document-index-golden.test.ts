/**
 * Stage 4 of the context-sections spec swaps swarm's index line renderer for
 * `@mnmal-ai/context-render`. Its gate: the same output as swarm's own
 * renderer. fixtures/document-index-golden.json holds that output, captured
 * from swarm's renderer before the swap, for realistic inputs (this
 * repository's docs, split as the sync splits them).
 *
 * The fixture's names were hand-edited when the previous engine's name was
 * removed from the tree (same-length replacements, so token counts and
 * ordering are unchanged), and the generator script was removed with that
 * engine's package. The split helpers now live in
 * packages/substrate-shared/src/split.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DocumentIndex, type DocumentIndexInput, renderDocumentIndex } from "../src/document-index.js";

const golden: Array<{ name: string; input: DocumentIndexInput; output: DocumentIndex }> = JSON.parse(
  readFileSync(new URL("./fixtures/document-index-golden.json", import.meta.url), "utf8"),
);

describe("document index against the output captured before stage 4", () => {
  it("covers expanding, folding and dropping", () => {
    expect(golden.some((g) => g.output.expanded > 0 && g.output.folded > 0)).toBe(true);
    expect(golden.some((g) => g.output.dropped > 0)).toBe(true);
    expect(golden.some((g) => g.output.text === "")).toBe(true);
  });

  for (const { name, input, output } of golden) {
    it(`renders byte for byte: ${name}`, () => {
      const rendered = renderDocumentIndex(input);
      expect(rendered.text).toBe(output.text);
      expect(rendered).toEqual(output);
    });
  }
});

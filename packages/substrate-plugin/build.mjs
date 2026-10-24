// Bundles the plugin into dist/ for an npm tarball that is installed into a
// Substrate runtime directory, where the workspace packages do not exist:
// `@mnmal-ai/swarm-substrate-shared` and `@mnmal-ai/swarm-types` (and anything
// else imported) are inlined; only `@mnmal-ai/substrate` (a peer, the
// runtime's own copy) and `zod` (a dependency) stay external. Declarations are
// emitted separately by `tsc -p tsconfig.build.json`.
import { rm } from "node:fs/promises";
import { build } from "esbuild";

const EXTERNAL = ["@mnmal-ai/substrate", "@mnmal-ai/substrate/*", "zod"];

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: { index: "src/index.ts", bootstrap: "src/bootstrap.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  format: "esm",
  platform: "node",
  target: "node22",
  external: EXTERNAL,
  sourcemap: false,
  logLevel: "warning",
});

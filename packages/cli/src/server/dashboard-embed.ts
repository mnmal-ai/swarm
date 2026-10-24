// This file is resolved by Bun's bundler at compile time.
// The HTML is embedded as a string constant in the compiled binary.
// In Node/tsc dev mode, this file is never imported — server/index.ts
// falls back to readFileSync instead.

// @ts-ignore — Bun text import
import html from "./dashboard.html" with { type: "text" };
export default html;

// Resolved by Bun's bundler at compile time: the two Axon CSS files become
// string constants inside the compiled binary. In Node/tsx dev mode this file
// fails to load (Node doesn't support `with { type: "text" }`), and
// server/index.ts falls back to reading the vendored CSS from disk next to this module.

// @ts-ignore — Bun text import
import tokens from "./axon/tokens.css" with { type: "text" };
// @ts-ignore — Bun text import
import light from "./axon/theme-light.css" with { type: "text" };

export default { tokens: tokens as string, light: light as string };

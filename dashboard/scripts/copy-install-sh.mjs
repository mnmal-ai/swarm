// Copies scripts/install.sh into public/ so Vite serves it on GitHub Pages.
// Run before `vite build` — see package.json "build" script.

import { copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "..", "scripts", "install.sh");
const dest = join(__dirname, "..", "public", "install.sh");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);

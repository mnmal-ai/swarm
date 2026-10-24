import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

let commitHash = "unknown";
try {
  commitHash = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {
  // Not a git repo or git not available
}

// Version resolution precedence:
//   1. SWARM_VERSION_OVERRIDE  — set by scripts/compile-release-binaries.sh
//      during @semantic-release/exec.prepareCmd, when the next tag has been
//      computed but not yet published. Bakes the incoming release version
//      into the Bun-compiled binary.
//   2. `git describe --tags --abbrev=0` — the latest reachable tag, stripped
//      of its leading "v". Correct for local dev builds on a tagged commit,
//      and for the old "compile after release" flow when workspace package.json
//      versions aren't bumped.
//   3. package.json `version` — final fallback for fresh clones with no tags.
let version = process.env.SWARM_VERSION_OVERRIDE;
if (!version) {
  try {
    const described = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (described.startsWith("v")) {
      version = described.slice(1); // strip 'v' prefix
    }
  } catch {
    // No tags — fall through to package.json below
  }
}
if (!version) version = pkg.version;

writeFileSync(
  "src/version.ts",
  `// Auto-generated — do not edit\nexport const VERSION = "${version}";\nexport const COMMIT_HASH = "${commitHash}";\n`
);

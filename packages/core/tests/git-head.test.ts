/**
 * The Swarm records the swarm repo's HEAD sha at construction. When the swarm
 * path is not a git repo, the lookup must quietly return "unknown" — it used
 * to let git's "fatal: not a git repository" through to the console at
 * startup and after every goal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readGitHeadSha } from "../src/git-head.js";

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const TSX = resolve(here, "../../../node_modules/.bin/tsx");
const SRC = resolve(here, "../src/git-head.ts");

describe("readGitHeadSha", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-git-head-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns HEAD's sha in a git repo", async () => {
    await execFile("git", ["init", "-b", "main"], { cwd: dir });
    await execFile("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "x"], { cwd: dir });
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: dir });
    expect(readGitHeadSha(dir)).toBe(stdout.trim());
  });

  it('returns "unknown" outside a git repo', () => {
    expect(readGitHeadSha(dir)).toBe("unknown");
  });

  // git writes to the inherited stderr file descriptor directly, so only a
  // separate process can observe whether anything reached the console.
  it.skipIf(!existsSync(TSX))("prints nothing to stderr outside a git repo", async () => {
    const script = join(dir, "probe.ts");
    await writeFile(
      script,
      `import { readGitHeadSha } from ${JSON.stringify(SRC)};\nprocess.stdout.write(readGitHeadSha(${JSON.stringify(dir)}));\n`,
    );
    const { stdout, stderr } = await execFile(TSX, [script], {
      cwd: dir,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) },
    });
    expect(stdout).toBe("unknown");
    expect(stderr).toBe("");
  });
});

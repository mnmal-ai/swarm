/**
 * Which swarm command is using a project right now. `swarm merge` switches
 * branches, gates and rewrites the checkpoint in the same work repo and
 * checkpoint a `swarm run` uses, so the two never overlap: each claims the
 * project (`<domain>/.checkpoints/active.json`) for as long as it runs, and
 * refuses to start while the other holds a live claim. A claim whose process
 * has died is ignored. Two runs of one project are not refused here: that is
 * as before this file.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectClaim {
  pid: number;
  command: "run" | "merge";
  since: string;
}

/** process.kill(pid, 0): ESRCH is gone; EPERM is someone else's live process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claim the project whose checkpoint directory is `checkpointDir` for
 * `command`. On success, `release` drops the claim (it is also dropped when
 * the process exits); otherwise `holder` says who has it.
 */
export async function claimProject(
  checkpointDir: string,
  command: ProjectClaim["command"],
  opts: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<{ ok: true; release: () => void } | { ok: false; holder: ProjectClaim }> {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  const path = join(checkpointDir, "active.json");
  await mkdir(checkpointDir, { recursive: true });

  let holder: ProjectClaim | undefined;
  try {
    holder = JSON.parse(await readFile(path, "utf8")) as ProjectClaim;
  } catch {
    holder = undefined; // none, or unreadable: nobody holds it
  }
  const conflicting = holder !== undefined && holder.pid !== pid && (command === "merge" || holder.command === "merge") && isAlive(holder.pid);
  if (conflicting) return { ok: false, holder: holder as ProjectClaim };

  const mine: ProjectClaim = { pid, command, since: new Date().toISOString() };
  const tmp = `${path}.${pid}.tmp`;
  await writeFile(tmp, JSON.stringify(mine));
  await rename(tmp, path);

  const release = (): void => {
    process.removeListener("exit", release);
    try {
      const now = JSON.parse(readFileSync(path, "utf8")) as ProjectClaim;
      if (now.pid === pid && now.command === command && now.since === mine.since) unlinkSync(path);
    } catch {
      // Already gone.
    }
  };
  process.once("exit", release);
  return { ok: true, release };
}

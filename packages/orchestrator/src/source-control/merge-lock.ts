/**
 * The repository merge lock and its first-come line (spec:
 * docs/superpowers/specs/2026-10-06-merge-queue-design.md). Every swarm
 * process on this machine that merges into one repository and base branch
 * takes turns here, whichever project, board or clone it runs from. Files,
 * not flock(2): `O_EXCL` creates are atomic on every platform swarm runs on,
 * and a stale holder is recognised by its pid (same host) or its heartbeat.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const MERGE_LOCK_POLL_MS = 5_000;
export const MERGE_LOCK_HEARTBEAT_MS = 30_000;
export const MERGE_LOCK_STALE_MS = 120_000;
export const MERGE_LINE_GUARD_RETRY_MS = 100;
export const MERGE_LINE_GUARD_STALE_MS = 10_000;
export const MERGE_TICKET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `<host>/<owner>/<repo>#<base>`, the same for every clone and URL form of one repository. */
export function repoKeyFromRemote(remoteUrl: string, base: string): string {
  const u = remoteUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].toLowerCase()}#${base}`;
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (url) return `${url[1].toLowerCase()}/${url[2].toLowerCase()}#${base}`;
  return `local/${u}#${base}`;
}

/** The key for the work repo's remote and base, asked of git. */
export function repoKeyFor(repoRoot: string, remote: string, base: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["remote", "get-url", remote], { cwd: repoRoot }, (err, stdout) => {
      if (err) reject(err);
      else resolve(repoKeyFromRemote(String(stdout), base));
    });
  });
}

export function defaultMergeQueueDir(): string {
  return join(homedir(), ".swarm", "merge");
}

export interface MergeTurnRequest { project: string; goalId: string; prUrl?: string }
export interface MergeWaiting { ahead: number; holder?: { project: string; pr?: string; since: string } }
export interface MergeTurn {
  readonly waitedMs: number;
  /** The project whose dead or silent turn this one took over. */
  readonly tookOverFrom?: string;
  release(): Promise<void>;
}
/** One merge per repository and base at a time, in the order asked. */
export interface MergeQueue {
  readonly repoKey: string;
  take(req: MergeTurnRequest, onWaiting?: (w: MergeWaiting) => void): Promise<MergeTurn>;
}

export interface FileMergeQueueOptions {
  dir?: string;
  pollMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
  guardRetryMs?: number;
  guardStaleMs?: number;
  host?: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

/** A place in line. `seen` is refreshed on every poll while waiting; a waiter that stops polling leaves the line after staleMs. */
interface Ticket { ticket: string; pid: number; host: string; project: string; goal: string; pr?: string; since: string; seen?: string }
interface LockRecord extends Ticket { heartbeat: string }

/** process.kill(pid, 0): ESRCH is gone; EPERM is someone else's live process. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FileMergeQueue implements MergeQueue {
  private readonly dir: string;
  private readonly linePath: string;
  private readonly guardPath: string;
  private readonly lockPath: string;
  private readonly o: Required<Omit<FileMergeQueueOptions, "dir">>;

  constructor(readonly repoKey: string, opts: FileMergeQueueOptions = {}) {
    this.dir = opts.dir ?? defaultMergeQueueDir();
    const slug = `${repoKey.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 60)}-${createHash("sha256").update(repoKey).digest("hex").slice(0, 12)}`;
    this.linePath = join(this.dir, `${slug}.line.json`);
    this.guardPath = join(this.dir, `${slug}.line.lock`);
    this.lockPath = join(this.dir, `${slug}.lock`);
    this.o = {
      pollMs: opts.pollMs ?? MERGE_LOCK_POLL_MS,
      heartbeatMs: opts.heartbeatMs ?? MERGE_LOCK_HEARTBEAT_MS,
      staleMs: opts.staleMs ?? MERGE_LOCK_STALE_MS,
      guardRetryMs: opts.guardRetryMs ?? MERGE_LINE_GUARD_RETRY_MS,
      guardStaleMs: opts.guardStaleMs ?? MERGE_LINE_GUARD_STALE_MS,
      host: opts.host ?? hostname(),
      pid: opts.pid ?? process.pid,
      isAlive: opts.isAlive ?? pidAlive,
      now: opts.now ?? Date.now,
    };
  }

  async take(req: MergeTurnRequest, onWaiting?: (w: MergeWaiting) => void): Promise<MergeTurn> {
    await mkdir(this.dir, { recursive: true });
    const mine: Ticket = {
      ticket: randomUUID(),
      pid: this.o.pid,
      host: this.o.host,
      project: req.project,
      goal: req.goalId,
      ...(req.prUrl ? { pr: req.prUrl } : {}),
      since: new Date(this.o.now()).toISOString(),
    };
    const started = this.o.now();
    let announced = "";
    let tookOverFrom: string | undefined;
    for (;;) {
      let step: { got: boolean; took?: string; ahead: number; holder?: LockRecord | "corrupt" };
      try {
        step = await this.withGuard(async () => {
          let lock = await this.readLock();
          let line = this.prune(await this.readLine(), lock, mine.ticket);
          let took: string | undefined;
          if (lock !== undefined && (await this.isStale(lock))) {
            const stale = lock;
            await unlink(this.lockPath).catch(() => {});
            if (stale !== "corrupt") line = line.filter((t) => t.ticket !== stale.ticket);
            took = stale === "corrupt" ? "an unreadable lock" : stale.project;
            lock = undefined;
          }
          const seen = new Date(this.o.now()).toISOString();
          const at = line.findIndex((t) => t.ticket === mine.ticket);
          if (at < 0) line.push({ ...mine, seen });
          else line[at] = { ...line[at], seen };
          let got = false;
          if (lock === undefined && line[0].ticket === mine.ticket) {
            await this.writeLockExclusive({ ...mine, heartbeat: new Date(this.o.now()).toISOString() });
            got = true;
          }
          await this.writeLine(line);
          return { got, took, ahead: line.findIndex((t) => t.ticket === mine.ticket), holder: lock };
          });
      } catch (err) {
        // Leave no ticket (or half-taken lock) behind to hold up the line; if
        // even that fails, the ticket goes once it is not seen for staleMs.
        await this.abandon(mine.ticket);
        throw err;
      }
      if (step.took) tookOverFrom = step.took;
      if (step.got) break;
      const holder = step.holder && step.holder !== "corrupt" ? step.holder : undefined;
      const key = `${step.ahead}:${holder?.ticket ?? ""}`;
      if (key !== announced) {
        announced = key;
        onWaiting?.({ ahead: step.ahead, ...(holder ? { holder: { project: holder.project, ...(holder.pr ? { pr: holder.pr } : {}), since: holder.since } } : {}) });
      }
      await sleep(this.o.pollMs);
    }
    const waitedMs = this.o.now() - started;
    const beat = setInterval(() => void this.heartbeat(mine.ticket), this.o.heartbeatMs);
    beat.unref();
    const onExit = () => this.releaseSync(mine.ticket);
    process.once("exit", onExit);
    let released = false;
    return {
      waitedMs,
      ...(tookOverFrom ? { tookOverFrom } : {}),
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        process.removeListener("exit", onExit);
        await this.withGuard(async () => {
          const lock = await this.readLock();
          if (lock !== undefined && lock !== "corrupt" && lock.ticket === mine.ticket) await unlink(this.lockPath).catch(() => {});
          await this.writeLine((await this.readLine()).filter((t) => t.ticket !== mine.ticket));
        });
      },
    };
  }

  /** Same host: a dead pid. Any host: no heartbeat within staleMs. Unreadable: older than staleMs. */
  private async isStale(lock: LockRecord | "corrupt"): Promise<boolean> {
    if (lock === "corrupt") {
      try {
        return this.o.now() - (await stat(this.lockPath)).mtimeMs > this.o.staleMs;
      } catch {
        return true;
      }
    }
    if (lock.host === this.o.host && !this.o.isAlive(lock.pid)) return true;
    return this.o.now() - Date.parse(lock.heartbeat) > this.o.staleMs;
  }

  /**
   * Tickets of dead processes on this host, tickets older than a day, and
   * waiting tickets not seen polling for staleMs leave the line. The lock
   * holder's ticket (it no longer polls) and `keep` (the caller's) stay.
   */
  private prune(line: Ticket[], lock: LockRecord | "corrupt" | undefined, keep: string): Ticket[] {
    const now = this.o.now();
    const holder = lock !== undefined && lock !== "corrupt" ? lock.ticket : undefined;
    return line.filter((t) => {
      if (t.host === this.o.host && !this.o.isAlive(t.pid)) return false;
      if (now - Date.parse(t.since) >= MERGE_TICKET_MAX_AGE_MS) return false;
      if (t.ticket === keep || t.ticket === holder) return true;
      return now - Date.parse(t.seen ?? t.since) <= this.o.staleMs;
    });
  }

  /** Best effort, after take() failed: this ticket leaves the line, and a lock it created goes. */
  private async abandon(ticket: string): Promise<void> {
    try {
      await this.withGuard(async () => {
        const lock = await this.readLock();
        if (lock !== undefined && lock !== "corrupt" && lock.ticket === ticket) await unlink(this.lockPath).catch(() => {});
        await this.writeLine((await this.readLine()).filter((t) => t.ticket !== ticket));
      });
    } catch {
      // The directory is still unusable: the ticket is pruned once it is not seen.
    }
  }

  private async withGuard<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        const h = await open(this.guardPath, "wx");
        await h.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        let stale = false;
        try {
          stale = this.o.now() - (await stat(this.guardPath)).mtimeMs > this.o.guardStaleMs;
        } catch {
          // Gone between the open and the stat: try again.
        }
        if (stale) {
          // A stale guard that cannot be removed (the directory cannot be
          // written) would be waited on forever: fail, and the merge goes on
          // without a turn, saying so.
          await unlink(this.guardPath).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e;
          });
        }
        await sleep(this.o.guardRetryMs);
      }
    }
    try {
      return await fn();
    } finally {
      await unlink(this.guardPath).catch(() => {});
    }
  }

  private async readLine(): Promise<Ticket[]> {
    try {
      const parsed = JSON.parse(await readFile(this.linePath, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as Ticket[]) : [];
    } catch {
      return [];
    }
  }

  private async writeLine(line: Ticket[]): Promise<void> {
    const tmp = `${this.linePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(line));
    await rename(tmp, this.linePath);
  }

  private async readLock(): Promise<LockRecord | "corrupt" | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.lockPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const rec = JSON.parse(raw) as LockRecord;
      return typeof rec.ticket === "string" && typeof rec.heartbeat === "string" ? rec : "corrupt";
    } catch {
      return "corrupt";
    }
  }

  private async writeLockExclusive(rec: LockRecord): Promise<void> {
    const h = await open(this.lockPath, "wx");
    try {
      await h.writeFile(JSON.stringify(rec));
    } finally {
      await h.close();
    }
  }

  /** Refresh the heartbeat while the lock is still this ticket's (atomic rewrite). */
  private async heartbeat(ticket: string): Promise<void> {
    const lock = await this.readLock();
    if (lock === undefined || lock === "corrupt" || lock.ticket !== ticket) return;
    const tmp = `${this.lockPath}.${process.pid}.hb.tmp`;
    await writeFile(tmp, JSON.stringify({ ...lock, heartbeat: new Date(this.o.now()).toISOString() })).catch(() => {});
    await rename(tmp, this.lockPath).catch(() => {});
  }

  /** On process exit: drop the lock if it is still ours. The ticket is pruned by pid later. */
  private releaseSync(ticket: string): void {
    try {
      const rec = JSON.parse(readFileSync(this.lockPath, "utf8")) as LockRecord;
      if (rec.ticket === ticket) unlinkSync(this.lockPath);
    } catch {
      // Nothing to release.
    }
  }
}

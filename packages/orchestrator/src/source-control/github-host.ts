/**
 * GitHub as swarm's code host, through the `gh` CLI. With a GitHubCredential
 * (source_control.github_account), gh runs and git's pushes, fetches and
 * ls-remotes to an HTTPS GitHub remote are made as that account: its token
 * goes in those calls' env only. Without one, gh's active account and git's
 * own credentials are used, as before.
 */

import { execFile } from "node:child_process";
import type { GitHubCredential } from "@mnmal-ai/swarm-types";
import { GH_GIT_CREDENTIAL_ARGS, isHttpsGitHubRemote } from "@mnmal-ai/swarm-types";
import type { ChangeRequestView, CodeHost, Mergeability, PinnedMergeOutcome } from "./code-host.js";

function execFileAsync(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
}

/** GitHub's refusals that mean the base changed, or it is still computing: worth another round. */
export const GITHUB_BASE_MOVED_REFUSAL = /base branch was modified|not mergeable/i;

export class GitHubCodeHost implements CodeHost {
  readonly name = "github";
  readonly displayName = "GitHub";
  /** Remote name → whether it is an HTTPS GitHub remote (asked of git once per remote). */
  private readonly httpsRemotes = new Map<string, boolean>();

  constructor(private readonly repoRoot: string, private readonly credential?: GitHubCredential) {}

  async openChangeRequest(o: { title: string; body: string; base: string; head: string }): Promise<string> {
    const { stdout } = await this.gh(["pr", "create", "--title", o.title, "--body", o.body, "--base", o.base, "--head", o.head]);
    return stdout.trim();
  }

  async findChangeRequest(head: string): Promise<ChangeRequestView | undefined> {
    try {
      const { stdout } = await this.gh(["pr", "view", head, "--json", "url,state,baseRefName"]);
      const v = JSON.parse(stdout) as { url?: string; state?: string; baseRefName?: string };
      return v.url ? { url: v.url, state: v.state ?? "UNKNOWN", base: v.baseRefName ?? "" } : undefined;
    } catch {
      return undefined;
    }
  }

  async viewChangeRequest(url: string): Promise<ChangeRequestView & { mergeCommit?: string }> {
    const { stdout } = await this.gh(["pr", "view", url, "--json", "url,state,baseRefName,mergeCommit"]);
    const v = JSON.parse(stdout) as { url?: string; state?: string; baseRefName?: string; mergeCommit?: { oid?: string } | null };
    if (!v.state) throw new Error(`gh pr view ${url} returned no state`);
    return { url: v.url ?? url, state: v.state, base: v.baseRefName ?? "", ...(v.mergeCommit?.oid ? { mergeCommit: v.mergeCommit.oid } : {}) };
  }

  async comment(url: string, body: string): Promise<void> {
    await this.gh(["pr", "comment", url, "--body", body]);
  }

  async mergeability(url: string): Promise<{ mergeable: Mergeability; headSha?: string }> {
    const { stdout } = await this.gh(["pr", "view", url, "--json", "mergeable,headRefOid"]);
    const v = JSON.parse(stdout) as { mergeable?: string; headRefOid?: string };
    const mergeable: Mergeability = v.mergeable === "MERGEABLE" || v.mergeable === "CONFLICTING" ? v.mergeable : "UNKNOWN";
    return { mergeable, ...(v.headRefOid ? { headSha: v.headRefOid } : {}) };
  }

  async mergePinned(url: string, headSha: string): Promise<PinnedMergeOutcome> {
    let mergeError: unknown;
    try {
      await this.gh(["pr", "merge", url, "--merge", "--match-head-commit", headSha]);
    } catch (err) {
      mergeError = err;
    }
    // Ask GitHub what happened rather than trust the merge call's exit: a
    // merge can succeed with a failing follow-up, and a failed call can leave
    // the PR open. Only GitHub's answer decides.
    let view: { state?: string; mergeCommit?: { oid?: string } | null } | undefined;
    let viewError: unknown;
    for (let attempt = 0; attempt < 3 && view === undefined; attempt++) {
      try {
        const { stdout } = await this.gh(["pr", "view", url, "--json", "state,mergeCommit"]);
        view = JSON.parse(stdout) as { state?: string; mergeCommit?: { oid?: string } | null };
      } catch (err) {
        viewError = err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (view === undefined) return { kind: "unknown", error: viewError ?? mergeError };
    if (view.state === "MERGED") return { kind: "merged", ...(view.mergeCommit?.oid ? { mergeCommit: view.mergeCommit.oid } : {}) };
    const message = mergeError instanceof Error ? mergeError.message : String(mergeError ?? "");
    if (mergeError !== undefined && GITHUB_BASE_MOVED_REFUSAL.test(message)) return { kind: "base_moved", error: mergeError };
    return { kind: "refused", ...(mergeError !== undefined ? { error: mergeError } : {}), ...(view.state ? { state: view.state } : {}) };
  }

  async gitAuth(remote: string): Promise<{ args: readonly string[]; env: NodeJS.ProcessEnv } | undefined> {
    if (!this.credential) return undefined;
    let https = this.httpsRemotes.get(remote);
    if (https === undefined) {
      try {
        const { stdout } = await execFileAsync("git", ["remote", "get-url", remote], { cwd: this.repoRoot });
        https = isHttpsGitHubRemote(stdout.trim());
      } catch {
        https = false; // an unknown remote: the git call itself fails and says so
      }
      this.httpsRemotes.set(remote, https);
    }
    return https ? { args: GH_GIT_CREDENTIAL_ARGS, env: this.credential.env() } : undefined;
  }

  redact(text: string): string {
    return this.credential ? this.credential.redact(text) : text;
  }

  /** gh as the configured account (its token in this call's env only), the token masked in any error. */
  private async gh(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync("gh", args, { cwd: this.repoRoot, env: this.credential?.env() });
    } catch (err) {
      if (this.credential && err instanceof Error) err.message = this.credential.redact(err.message);
      throw err;
    }
  }
}

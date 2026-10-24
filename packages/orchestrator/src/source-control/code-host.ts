/**
 * Where swarm's pull requests live. Everything swarm does with a code host —
 * opening a pull request, finding one, commenting, asking whether it can
 * merge, merging it pinned to the commit the gate ran on, and authenticating
 * git to the host's remotes — goes through this interface. GitHub
 * (github-host.ts) is the first implementation.
 *
 * Adding a host (GitLab, Gitea, Bitbucket):
 *   1. Implement CodeHost in `<host>-host.ts`. GitLab's merge requests map
 *      one to one: `glab mr create`, `glab mr view`, `glab mr note`, the
 *      `merge_status`/`detailed_merge_status` field, and a merge with `sha`
 *      set (GitLab's pin), with a merge commit.
 *   2. Accept its name in `source_control.code_host` (commit-policy.ts), and
 *      construct it where the CLI builds the SourceControlManager (run.ts,
 *      merge-command.ts).
 *   3. Run tests/code-host.test.ts's MemoryHost scenarios against it.
 */

/** A change request (a GitHub pull request, a GitLab merge request) as swarm sees it. */
export interface ChangeRequestView {
  url: string;
  /** "OPEN" | "MERGED" | "CLOSED", in the host's terms mapped to these. */
  state: string;
  /** The branch it targets. */
  base: string;
}

/** Whether the host can merge it now; UNKNOWN while the host is still computing. */
export type Mergeability = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** What happened when swarm merged a change request pinned to a commit. */
export type PinnedMergeOutcome =
  | { kind: "merged"; mergeCommit?: string }
  /** Refused because the base changed (or the host could not merge yet): worth another round. */
  | { kind: "base_moved"; error: unknown }
  /** Any other refusal, or the host reports a state that is not merged. */
  | { kind: "refused"; error?: unknown; state?: string }
  /** The host's answer could not be read: never reported as a refusal or a merge. */
  | { kind: "unknown"; error: unknown };

export interface CodeHost {
  /** Its `source_control.code_host` name, e.g. "github". */
  readonly name: string;
  /** Its name in swarm's own messages, e.g. "GitHub". */
  readonly displayName: string;
  /** Open a change request from `head` into `base`. Returns its URL, or "" when the host returned none. Throws with the host's error. */
  openChangeRequest(o: { title: string; body: string; base: string; head: string }): Promise<string>;
  /** The change request for branch `head`, or undefined when there is none or it cannot be read. */
  findChangeRequest(head: string): Promise<ChangeRequestView | undefined>;
  /** The change request at `url` as the host sees it now, with its merge commit when merged. Throws when it cannot be read. */
  viewChangeRequest(url: string): Promise<ChangeRequestView & { mergeCommit?: string }>;
  /** Post `body` on the change request. Throws on failure. */
  comment(url: string, body: string): Promise<void>;
  /** Whether the host can merge it now, and the head commit the host sees. Throws on failure. */
  mergeability(url: string): Promise<{ mergeable: Mergeability; headSha?: string }>;
  /** Merge with a merge commit, only if the head is still `headSha`, then confirm with the host. Never throws. */
  mergePinned(url: string, headSha: string): Promise<PinnedMergeOutcome>;
  /** Extra git arguments and environment that authenticate git to `remote` as swarm's account, or undefined for git's own configuration. */
  gitAuth(remote: string): Promise<{ args: readonly string[]; env: NodeJS.ProcessEnv } | undefined>;
  /** `text` with the host's secrets masked. */
  redact(text: string): string;
}

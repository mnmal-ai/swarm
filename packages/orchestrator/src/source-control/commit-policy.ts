/**
 * Commit identity and subject format for the commits swarm makes in the work
 * repo, from `source_control.git_identity` and `source_control.commit_style`.
 */

import type { CommitStyle, GitIdentity } from "@mnmal-ai/swarm-types";
import { gitIdentityEnvVars } from "@mnmal-ai/swarm-types";

/** A Conventional Commit subject: `type(scope)!: summary`, scope and `!` optional. */
export const CONVENTIONAL_COMMIT_SUBJECT = /^[a-z]+(\([^)]+\))?!?: \S/;

/**
 * The subject line for a task's commit.
 *
 * "swarm" (default): `swarm(<task-id>): <title>`.
 * "conventional": the title itself when it is already a Conventional Commit
 * subject, else `chore(swarm): <title>`.
 */
export function taskCommitSubject(task: { id: string; title?: string }, style: CommitStyle = "swarm"): string {
  const title = task.title ?? "task completed";
  if (style === "conventional") {
    return CONVENTIONAL_COMMIT_SUBJECT.test(title) ? title : `chore(swarm): ${title}`;
  }
  return `swarm(${task.id}): ${title}`;
}

/**
 * The message for a worktree merge commit, or undefined to keep git's own
 * `Merge branch '…'` message (swarm style, unchanged).
 */
export function mergeCommitMessage(branch: string, style: CommitStyle = "swarm"): string | undefined {
  return style === "conventional" ? `chore(swarm): merge ${branch}` : undefined;
}

/** The message for the initial commit swarm makes in a repo with no commits. */
export function initialCommitMessage(style: CommitStyle = "swarm"): string {
  return style === "conventional" ? "chore(swarm): initial commit" : "initial commit (created by swarm)";
}

/**
 * Environment for a git command that creates commits, so that author AND
 * committer are `identity`. GIT_AUTHOR_* / GIT_COMMITTER_* outrank every git
 * config source (user.*, author.*, committer.*, `-c`), and replace any
 * inherited values. Undefined when no identity is configured (inherit).
 */
export function gitIdentityEnv(identity: GitIdentity | undefined): NodeJS.ProcessEnv | undefined {
  if (!identity) return undefined;
  return { ...process.env, ...gitIdentityEnvVars(identity) };
}

const EMAIL = /^[^\s<>@]+@[^\s<>@]+$/;

/** A GitHub login: letters, digits and hyphens, 1–39 characters, not starting
 *  with a hyphen (which gh would also read as a flag). */
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * Validate the commit- and account-related keys of a `source_control` config
 * block (git_identity, commit_style, github_account), refuse stack_prs
 * without remote_pr (workers cannot open the PRs), and check merge_prs.
 * Returns one message per problem (empty when valid), each naming the key.
 */
export function validateSourceControlConfig(sourceControl: unknown): string[] {
  if (sourceControl === undefined || sourceControl === null || typeof sourceControl !== "object") return [];
  const sc = sourceControl as Record<string, unknown>;
  const errors: string[] = [];

  if (sc.git_identity !== undefined) {
    const id = sc.git_identity;
    if (id === null || typeof id !== "object" || Array.isArray(id)) {
      errors.push(`source_control.git_identity must be an object: { "name": "…", "email": "…" }`);
    } else {
      const { name, email } = id as Record<string, unknown>;
      if (typeof name !== "string" || name.trim() === "" || /[<>\n\r]/.test(name)) {
        errors.push(`source_control.git_identity.name must be a non-empty string without "<", ">" or line breaks (got ${JSON.stringify(name)})`);
      }
      if (typeof email !== "string" || !EMAIL.test(email)) {
        errors.push(`source_control.git_identity.email must be an email address like "name@example.com" (got ${JSON.stringify(email)})`);
      }
    }
  }

  if (sc.commit_style !== undefined && sc.commit_style !== "swarm" && sc.commit_style !== "conventional") {
    errors.push(`source_control.commit_style must be "swarm" or "conventional" (got ${JSON.stringify(sc.commit_style)})`);
  }

  if (sc.github_account !== undefined && (typeof sc.github_account !== "string" || !GITHUB_LOGIN.test(sc.github_account))) {
    errors.push(`source_control.github_account must be a GitHub login like "example-bot" (got ${JSON.stringify(sc.github_account)})`);
  }

  if (sc.code_host !== undefined && sc.code_host !== "github") {
    errors.push(
      `source_control.code_host must be "github", the only code host swarm supports so far (got ${JSON.stringify(sc.code_host)}). ` +
        `A new host is one more implementation of CodeHost (packages/orchestrator/src/source-control/code-host.ts).`,
    );
  }

  // stack_prs without remote_pr used to leave the stacked PRs to the workers.
  // Workers have no GitHub access now, so such a run would end with no PR:
  // refuse it before any work.
  if (sc.stack_prs === true && sc.strategy !== "remote_pr") {
    const strategy = typeof sc.strategy === "string" ? `'${sc.strategy}'` : "unset";
    errors.push(
      `source_control.stack_prs is on but strategy is ${strategy}: workers no longer have GitHub access, so they cannot open pull requests. ` +
        `Set source_control.strategy to "remote_pr" so swarm opens them (or turn stack_prs off).`,
    );
  }

  errors.push(...validateMergePrsConfig(sc));

  return errors;
}

const MERGE_PRS_KEYS = new Set(["enabled", "gate", "skip_labels", "after_merge", "max_rounds", "resolve_conflicts", "max_conflict_rounds"]);
const MERGE_GATE_KEYS = new Set(["command", "cwd", "env", "timeout_ms"]);

/**
 * `source_control.merge_prs`: the shape, unknown keys, and what it needs when
 * enabled (remote_pr, github_account, a gate command, and no stack_prs —
 * merging each goal as it finishes and stacking goals on each other are two
 * different plans for the same branches, so the run refuses both).
 */
function validateMergePrsConfig(sc: Record<string, unknown>): string[] {
  if (sc.merge_prs === undefined) return [];
  const mp = sc.merge_prs;
  if (mp === null || typeof mp !== "object" || Array.isArray(mp)) {
    return [`source_control.merge_prs must be an object like { "enabled": true, "gate": { "command": "…" } } (got ${JSON.stringify(mp)})`];
  }
  const m = mp as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(m)) {
    if (!MERGE_PRS_KEYS.has(key)) {
      errors.push(`source_control.merge_prs has an unknown key "${key}" (known: ${[...MERGE_PRS_KEYS].join(", ")})`);
    }
  }
  if (m.enabled !== undefined && typeof m.enabled !== "boolean") {
    errors.push(`source_control.merge_prs.enabled must be true or false (got ${JSON.stringify(m.enabled)})`);
  }
  if (m.skip_labels !== undefined && (!Array.isArray(m.skip_labels) || m.skip_labels.some((l) => typeof l !== "string" || l.trim() === ""))) {
    errors.push(`source_control.merge_prs.skip_labels must be a list of non-empty strings (got ${JSON.stringify(m.skip_labels)})`);
  }
  if (m.after_merge !== undefined && m.after_merge !== "done" && m.after_merge !== "review") {
    errors.push(`source_control.merge_prs.after_merge must be "done" or "review" (got ${JSON.stringify(m.after_merge)})`);
  }
  if (m.max_rounds !== undefined && (typeof m.max_rounds !== "number" || !Number.isInteger(m.max_rounds) || m.max_rounds <= 0)) {
    errors.push(`source_control.merge_prs.max_rounds must be a positive whole number (got ${JSON.stringify(m.max_rounds)})`);
  }
  if (m.resolve_conflicts !== undefined && typeof m.resolve_conflicts !== "boolean") {
    errors.push(`source_control.merge_prs.resolve_conflicts must be true or false (got ${JSON.stringify(m.resolve_conflicts)})`);
  }
  if (
    m.max_conflict_rounds !== undefined &&
    (typeof m.max_conflict_rounds !== "number" || !Number.isInteger(m.max_conflict_rounds) || m.max_conflict_rounds < 0)
  ) {
    errors.push(`source_control.merge_prs.max_conflict_rounds must be a whole number, 0 or more (got ${JSON.stringify(m.max_conflict_rounds)})`);
  }
  if (m.gate !== undefined) {
    const g = m.gate;
    if (g === null || typeof g !== "object" || Array.isArray(g)) {
      errors.push(`source_control.merge_prs.gate must be an object like { "command": "…" } (got ${JSON.stringify(g)})`);
    } else {
      const gate = g as Record<string, unknown>;
      for (const key of Object.keys(gate)) {
        if (!MERGE_GATE_KEYS.has(key)) {
          errors.push(`source_control.merge_prs.gate has an unknown key "${key}" (known: ${[...MERGE_GATE_KEYS].join(", ")})`);
        }
      }
      if (typeof gate.command !== "string" || gate.command.trim() === "") {
        errors.push(`source_control.merge_prs.gate.command must be a non-empty shell command (got ${JSON.stringify(gate.command)})`);
      }
      if (gate.cwd !== undefined && (typeof gate.cwd !== "string" || gate.cwd.startsWith("/") || gate.cwd.split(/[\\/]/).includes(".."))) {
        errors.push(`source_control.merge_prs.gate.cwd must be a path inside the work repo, relative to its root (got ${JSON.stringify(gate.cwd)})`);
      }
      if (
        gate.env !== undefined &&
        (gate.env === null || typeof gate.env !== "object" || Array.isArray(gate.env) || Object.values(gate.env).some((v) => typeof v !== "string"))
      ) {
        errors.push(`source_control.merge_prs.gate.env must be an object of string values (got ${JSON.stringify(gate.env)})`);
      }
      if (gate.timeout_ms !== undefined && (typeof gate.timeout_ms !== "number" || !Number.isInteger(gate.timeout_ms) || gate.timeout_ms <= 0)) {
        errors.push(`source_control.merge_prs.gate.timeout_ms must be a positive whole number of milliseconds (got ${JSON.stringify(gate.timeout_ms)})`);
      }
    }
  }
  if (m.enabled === true) {
    if (sc.strategy !== "remote_pr") {
      const strategy = typeof sc.strategy === "string" ? `'${sc.strategy}'` : "unset";
      errors.push(`source_control.merge_prs is enabled but strategy is ${strategy}: swarm can only merge pull requests it opens. Set source_control.strategy to "remote_pr".`);
    }
    if (typeof sc.github_account !== "string" || sc.github_account === "") {
      errors.push(`source_control.merge_prs is enabled but source_control.github_account is unset: name the account swarm merges as.`);
    }
    if (m.gate === undefined) {
      errors.push(`source_control.merge_prs is enabled but has no gate: set source_control.merge_prs.gate.command to the command that must pass before a merge.`);
    }
    if (sc.auto_push === false || sc.pr_on_goal_complete === false) {
      errors.push(`source_control.merge_prs is enabled but auto_push or pr_on_goal_complete is false: merging needs the branch pushed and its pull request open. Remove those settings or turn merge_prs off.`);
    }
    if (sc.stack_prs === true) {
      errors.push(`source_control.merge_prs and source_control.stack_prs are both on: merge-as-you-go starts every goal from the merged base branch, so it cannot stack. Turn stack_prs off.`);
    }
  }
  return errors;
}

/** Defaults for source_control.merge_prs. */
export const MERGE_PRS_DEFAULT_SKIP_LABELS: readonly string[] = ["swarm_merge: false"];
export const MERGE_PRS_DEFAULT_GATE_TIMEOUT_MS = 60 * 60 * 1000;
export const MERGE_PRS_DEFAULT_MAX_ROUNDS = 3;
export const MERGE_PRS_DEFAULT_MAX_CONFLICT_ROUNDS = 2;

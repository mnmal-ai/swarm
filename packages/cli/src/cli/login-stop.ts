/**
 * An expired agent login is a stop for the whole run, not a task failure.
 *
 * Every role's backend is wrapped by {@link watchLogin}: the first session
 * that fails because the login is gone trips the run's {@link LoginStop}, and
 * every session after it fails at once with the same error instead of making
 * another doomed call. `swarm run` listens on the stop: it stops dispatching,
 * leaves the in-flight goal unfailed (its source item goes back to the
 * queue), saves the checkpoint and exits non-zero, so a plain re-run after
 * logging in resumes where the run stopped. Nothing falls back to another
 * backend or an API key.
 */

import type { AgentRuntime, IWorkerBackend, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";
import { LoginExpiredError, isLoginExpired, loginExpiredMessage } from "@mnmal-ai/swarm-types";
import { redactGateOutput } from "@mnmal-ai/swarm-orchestrator";

export class LoginStop {
  private detailText: string | null = null;
  private runtimeName: AgentRuntime = "claude";
  private readonly listeners: Array<(detail: string) => void> = [];

  /** Whether the login has expired during this run. */
  get tripped(): boolean {
    return this.detailText !== null;
  }

  /** The runtime's error text from the session that tripped the stop. */
  get detail(): string | null {
    return this.detailText;
  }

  /** Whose login expired: "claude" unless a codex session tripped the stop. */
  get runtime(): AgentRuntime {
    return this.runtimeName;
  }

  /** Record the expiry. Only the first call counts, and notifies listeners. */
  trip(detail: string, runtime: AgentRuntime = "claude"): void {
    if (this.detailText !== null) return;
    this.detailText = detail;
    this.runtimeName = runtime;
    for (const listener of this.listeners) listener(detail);
  }

  /** Call `listener` when the stop trips; at once if it already has. */
  onTrip(listener: (detail: string) => void): void {
    this.listeners.push(listener);
    if (this.detailText !== null) listener(this.detailText);
  }
}

/** The runtime's own words from a login failure, without swarm's wrapping:
 *  one line, common secret shapes redacted, since it is printed and emitted. */
function loginDetail(err: unknown): string {
  let text = err instanceof Error ? err.message : String(err);
  if (err instanceof LoginExpiredError || (err instanceof Error && err.name === "LoginExpiredError")) {
    const detail = (err as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail !== "") text = detail;
  }
  return redactGateOutput(text.split("\n")[0]).slice(0, 300);
}

/** Whose login failed: the error's own runtime, else the backend's. */
function runtimeOf(err: unknown, backend: IWorkerBackend): AgentRuntime {
  const runtime = (err as { runtime?: unknown } | null)?.runtime;
  if (runtime === "claude" || runtime === "codex") return runtime;
  return backend.type === "codex" ? "codex" : "claude";
}

/**
 * `backend`, watched for an expired login: a session that fails with one
 * trips `stop` and rethrows as a {@link LoginExpiredError}; once `stop` has
 * tripped, every session fails at once without calling the runtime.
 */
export function watchLogin(backend: IWorkerBackend, stop: LoginStop): IWorkerBackend {
  return {
    type: backend.type,
    model: backend.model,
    supportsDirectExecution: backend.supportsDirectExecution,
    isAvailable: () => backend.isAvailable(),
    async execute(input: WorkerTaskInput): Promise<WorkerTaskOutput> {
      if (stop.tripped) throw new LoginExpiredError(stop.detail ?? "", stop.runtime);
      try {
        return await backend.execute(input);
      } catch (err) {
        if (!isLoginExpired(err)) throw err;
        const detail = loginDetail(err);
        const runtime = runtimeOf(err, backend);
        stop.trip(detail, runtime);
        throw err instanceof LoginExpiredError ? err : new LoginExpiredError(detail, runtime);
      }
    },
  };
}

/** The banner `swarm run` prints when it stops for an expired login. */
export function loginExpiredBanner(detail: string | null, runtime: AgentRuntime = "claude"): string[] {
  return [
    "",
    "  ════════════════════════════════════════════════════════════",
    `  ${loginExpiredMessage(runtime)}`,
    "  ════════════════════════════════════════════════════════════",
    ...(detail ? [`  The runtime said: ${detail}`] : []),
    "  Swarm stopped dispatching. Nothing was marked failed, the goal it was",
    "  working on went back to the queue, and the checkpoint is saved.",
    "",
  ];
}

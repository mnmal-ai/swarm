import { describe, it, expect, vi } from "vitest";
import { CODEX_LOGIN_EXPIRED_MESSAGE, LOGIN_EXPIRED_MESSAGE, LoginExpiredError } from "@mnmal-ai/swarm-types";
import type { IWorkerBackend, WorkerTaskInput, WorkerTaskOutput } from "@mnmal-ai/swarm-types";
import { LoginStop, loginExpiredBanner, watchLogin } from "../src/cli/login-stop.js";

/**
 * An expired login stops the run: the first session that hits it trips the
 * run's LoginStop, and every session after fails at once instead of calling
 * the runtime again.
 */

const INPUT: WorkerTaskInput = { task: "t", workingDirectory: "/tmp", swarmContext: "" };
const OK: WorkerTaskOutput = { output: "done", latencyMs: 1, tokensUsed: { input: 1, output: 1 }, filesChanged: [], backendUsed: "claude-code" };

function backend(results: Array<WorkerTaskOutput | Error>): IWorkerBackend & { execute: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    type: "claude-code",
    model: "some-model",
    supportsDirectExecution: true,
    isAvailable: async () => true,
    execute: vi.fn(async () => {
      const r = results[Math.min(call++, results.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    }),
  };
}

describe("watchLogin", () => {
  it("passes sessions and other failures through untouched", async () => {
    const stop = new LoginStop();
    const inner = backend([OK, new Error("socket hang up")]);
    const watched = watchLogin(inner, stop);

    expect(watched.type).toBe("claude-code");
    expect(watched.model).toBe("some-model");
    expect(watched.supportsDirectExecution).toBe(true);
    await expect(watched.execute(INPUT)).resolves.toBe(OK);
    await expect(watched.execute(INPUT)).rejects.toThrow("socket hang up");
    expect(stop.tripped).toBe(false);
  });

  it("trips the stop on a LoginExpiredError and rethrows it", async () => {
    const stop = new LoginStop();
    const watched = watchLogin(backend([new LoginExpiredError("OAuth session expired and could not be refreshed")]), stop);

    await expect(watched.execute(INPUT)).rejects.toThrow(LoginExpiredError);
    expect(stop.tripped).toBe(true);
    expect(stop.detail).toBe("OAuth session expired and could not be refreshed");
  });

  it("recognizes an untyped login failure and rethrows it typed", async () => {
    const stop = new LoginStop();
    const watched = watchLogin(backend([new Error("API Error: 401 authentication_error")]), stop);

    await expect(watched.execute(INPUT)).rejects.toBeInstanceOf(LoginExpiredError);
    expect(stop.detail).toBe("API Error: 401 authentication_error");
  });

  it("redacts secret shapes from what it prints and emits", async () => {
    const stop = new LoginStop();
    const watched = watchLogin(backend([new Error("401 Unauthorized: key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 rejected")]), stop);

    await expect(watched.execute(INPUT)).rejects.toBeInstanceOf(LoginExpiredError);
    expect(stop.detail).toContain("401 Unauthorized");
    expect(stop.detail).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("fails every later session at once, on any backend sharing the stop", async () => {
    const stop = new LoginStop();
    const worker = watchLogin(backend([new LoginExpiredError("expired")]), stop);
    const reviewerInner = backend([OK]);
    const reviewer = watchLogin(reviewerInner, stop);

    await expect(worker.execute(INPUT)).rejects.toThrow(LoginExpiredError);
    await expect(reviewer.execute(INPUT)).rejects.toThrow(LoginExpiredError);
    expect(reviewerInner.execute).not.toHaveBeenCalled();
  });
});

describe("LoginStop", () => {
  it("notifies listeners once, and a late listener at once", () => {
    const stop = new LoginStop();
    const early = vi.fn();
    stop.onTrip(early);
    stop.trip("first");
    stop.trip("second");
    const late = vi.fn();
    stop.onTrip(late);

    expect(early).toHaveBeenCalledTimes(1);
    expect(early).toHaveBeenCalledWith("first");
    expect(late).toHaveBeenCalledWith("first");
    expect(stop.detail).toBe("first");
  });

  it("has a banner that says what to do", () => {
    const banner = loginExpiredBanner("OAuth session expired").join("\n");
    expect(banner).toContain(LOGIN_EXPIRED_MESSAGE);
    expect(banner).toContain("The runtime said: OAuth session expired");
    expect(banner).toContain("Nothing was marked failed");
  });
});

describe("whose login", () => {
  it("prints exactly the Claude banner for a Claude login", () => {
    expect(loginExpiredBanner("x")).toEqual(loginExpiredBanner("x", "claude"));
    expect(loginExpiredBanner("x").join("\n")).toContain(LOGIN_EXPIRED_MESSAGE);
  });

  it("names codex when a codex backend's login failed", async () => {
    const stop = new LoginStop();
    const codex: IWorkerBackend = { ...backend([OK]), type: "codex", execute: async () => { throw new LoginExpiredError("401 Unauthorized", "codex"); } };
    await expect(watchLogin(codex, stop).execute(INPUT)).rejects.toThrow(CODEX_LOGIN_EXPIRED_MESSAGE);
    expect(stop.runtime).toBe("codex");
    expect(loginExpiredBanner(stop.detail, stop.runtime).join("\n")).toContain(CODEX_LOGIN_EXPIRED_MESSAGE);
    // later sessions fail at once, still naming codex
    await expect(watchLogin(codex, stop).execute(INPUT)).rejects.toMatchObject({ runtime: "codex" });
  });

  it("treats a plain login-failure error from a codex backend as a codex login", async () => {
    const stop = new LoginStop();
    const codex: IWorkerBackend = { ...backend([OK]), type: "codex", execute: async () => { throw new Error("status code 401"); } };
    await expect(watchLogin(codex, stop).execute(INPUT)).rejects.toMatchObject({ runtime: "codex" });
    expect(stop.runtime).toBe("codex");
  });

  it("keeps a Claude stop's runtime as claude", async () => {
    const stop = new LoginStop();
    await expect(watchLogin(backend([new LoginExpiredError("expired")]), stop).execute(INPUT)).rejects.toThrow(LoginExpiredError);
    expect(stop.runtime).toBe("claude");
  });
});

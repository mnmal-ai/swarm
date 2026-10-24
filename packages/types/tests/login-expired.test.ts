import { describe, expect, it } from "vitest";
import { CODEX_LOGIN_EXPIRED_MESSAGE, LOGIN_EXPIRED_MESSAGE, LoginExpiredError, isLoginExpired, isLoginFailure, loginExpiredMessage } from "../src/login-expired.js";

describe("isLoginFailure", () => {
  it.each([
    // What the Agent SDK threw when a subscription login's OAuth session lapsed mid-run.
    "Claude Agent SDK query failed: Error: Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed",
    "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    "Invalid API key · Please run /login",
    "Not logged in · Please run /login",
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    "Request failed with status code 401",
    "401 Unauthorized",
    "Your login has expired",
    "credentials have expired",
  ])("recognizes %s", (text) => {
    expect(isLoginFailure(text)).toBe(true);
  });

  it.each([
    "Claude Code rate limit hit. Resets at 6pm (America/Chicago) — 42 minute(s) from now.",
    "Claude Agent SDK query timed out after 1800 seconds.",
    "Claude Agent SDK query failed: Error: spawn claude ENOENT",
    "the handler returns 401 for a signed-out request",
    "test expected status 403 but got 200",
    "Prompt is too long",
  ])("does not mistake %s for one", (text) => {
    expect(isLoginFailure(text)).toBe(false);
  });
});

describe("isLoginExpired", () => {
  it("knows its own error, by class and by name", () => {
    expect(isLoginExpired(new LoginExpiredError("OAuth session expired"))).toBe(true);
    const twin = new Error("from another copy of the module");
    twin.name = "LoginExpiredError";
    expect(isLoginExpired(twin)).toBe(true);
  });

  it("reads an untyped error's message", () => {
    expect(isLoginExpired(new Error("Failed to authenticate: OAuth session expired"))).toBe(true);
    expect(isLoginExpired(new Error("ENOENT"))).toBe(false);
    expect(isLoginExpired("Please run /login")).toBe(true);
    expect(isLoginExpired(undefined)).toBe(false);
  });

  it("tells the operator what to do", () => {
    const err = new LoginExpiredError("OAuth session expired");
    expect(err.message).toContain(LOGIN_EXPIRED_MESSAGE);
    expect(err.detail).toBe("OAuth session expired");
    expect(LOGIN_EXPIRED_MESSAGE).toBe("Claude login expired: run `claude` and `/login`, then re-run to resume");
  });
});

describe("login messages per runtime", () => {
  it("keeps the Claude message exactly as it was", () => {
    expect(LOGIN_EXPIRED_MESSAGE).toBe("Claude login expired: run `claude` and `/login`, then re-run to resume");
    expect(loginExpiredMessage()).toBe(LOGIN_EXPIRED_MESSAGE);
    expect(loginExpiredMessage("claude")).toBe(LOGIN_EXPIRED_MESSAGE);
    const err = new LoginExpiredError("OAuth session expired");
    expect(err.message).toBe(`${LOGIN_EXPIRED_MESSAGE} (OAuth session expired)`);
    expect(err.runtime).toBe("claude");
  });

  it("names codex for a codex login", () => {
    expect(loginExpiredMessage("codex")).toBe(CODEX_LOGIN_EXPIRED_MESSAGE);
    const err = new LoginExpiredError("401 Unauthorized", "codex");
    expect(err.message).toBe(`${CODEX_LOGIN_EXPIRED_MESSAGE} (401 Unauthorized)`);
    expect(err.runtime).toBe("codex");
    expect(err.detail).toBe("401 Unauthorized");
  });
});

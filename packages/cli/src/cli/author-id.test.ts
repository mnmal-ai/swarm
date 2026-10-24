import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { resolveAuthorId } from "./author-id.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe("resolveAuthorId", () => {
  const originalUser = process.env.USER;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalUser === undefined) {
      delete process.env.USER;
    } else {
      process.env.USER = originalUser;
    }
  });

  it("prefers env USER over git config user.email", () => {
    process.env.USER = "example-user";
    mockedExecSync.mockReturnValue("git@example.com" as never);

    expect(resolveAuthorId()).toBe("example-user");
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("falls back to git config user.email when USER is unset", () => {
    delete process.env.USER;
    mockedExecSync.mockReturnValue("  git@example.com\n" as never);

    expect(resolveAuthorId()).toBe("git@example.com");
    expect(mockedExecSync).toHaveBeenCalledWith("git config user.email");
  });

  it("returns 'anonymous' when USER is unset and git fails", () => {
    delete process.env.USER;
    mockedExecSync.mockImplementation(() => {
      throw new Error("git not found");
    });

    expect(resolveAuthorId()).toBe("anonymous");
  });

  it("bounds an oversized env USER to 256 chars", () => {
    process.env.USER = "x".repeat(2000);
    expect(resolveAuthorId()).toHaveLength(256);
  });

  it("bounds an oversized git user.email to 256 chars", () => {
    delete process.env.USER;
    mockedExecSync.mockReturnValue("a".repeat(2000) as never);
    expect(resolveAuthorId()).toHaveLength(256);
  });
});

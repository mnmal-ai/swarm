/**
 * GitHub access helpers: parsing the work repo's remote, the credential swarm's
 * own gh/git calls use, and the environment workers get instead (no token, no
 * login). None of these tests runs gh or reads a real token.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { inspect } from "node:util";
import {
  parseGitRemote,
  isHttpsGitHubRemote,
  GitHubCredential,
  GH_GIT_CREDENTIAL_ARGS,
  GITHUB_TOKEN_ENV_VARS,
  withoutGitHubAccess,
  createEmptyGhConfigDir,
  defaultWorkerGhConfigDir,
} from "../src/index.js";

const FAKE_TOKEN = "gho_FAKE0000000000000000000000000000test";

describe("parseGitRemote", () => {
  it.each([
    ["https://github.com/example-org/sample-app.git", "github.com", true],
    ["https://github.com/example-org/sample-app", "github.com", true],
    ["https://github.com/example-org/sample-app/", "github.com", true],
    ["https://example-bot@github.com/example-org/sample-app.git", "github.com", true],
    ["https://x-access-token:abc@github.com/example-org/sample-app.git", "github.com", true],
    ["http://github.com/example-org/sample-app.git", "github.com", false],
    ["git@github.com:example-org/sample-app.git", "github.com", false],
    ["git@github.com:example-org/sample-app", "github.com", false],
    ["git@work-alias:example-org/sample-app.git", "work-alias", false],
    ["work-alias:example-org/sample-app.git", "work-alias", false],
    ["ssh://git@github.com/example-org/sample-app.git", "github.com", false],
    ["ssh://git@github.com:22/example-org/sample-app.git", "github.com", false],
    ["git://github.com/example-org/sample-app.git", "github.com", false],
  ])("reads owner/repo from %s", (url, host, https) => {
    expect(parseGitRemote(url)).toEqual({ host, owner: "example-org", repo: "sample-app", https });
  });

  it("keeps dots in a repo name that has no .git suffix", () => {
    expect(parseGitRemote("git@github.com:example-org/sample.app")).toMatchObject({ owner: "example-org", repo: "sample.app" });
  });

  it.each([
    "",
    "/local/path/to/repo",
    "../sibling-repo",
    "file:///local/path/repo.git",
    "https://github.com/example-org",
    "https://github.com/example-org/sample-app/tree/main",
  ])("returns null for %j", (url) => {
    expect(parseGitRemote(url)).toBeNull();
  });
});

describe("isHttpsGitHubRemote", () => {
  it("is true only for an https URL on github.com", () => {
    expect(isHttpsGitHubRemote("https://github.com/example-org/sample-app.git")).toBe(true);
    expect(isHttpsGitHubRemote("git@github.com:example-org/sample-app.git")).toBe(false);
    expect(isHttpsGitHubRemote("git@work-alias:example-org/sample-app.git")).toBe(false);
    expect(isHttpsGitHubRemote("ssh://git@github.com/example-org/sample-app.git")).toBe(false);
    expect(isHttpsGitHubRemote("https://gitlab.example.com/example-org/sample-app.git")).toBe(false);
    expect(isHttpsGitHubRemote("/local/path")).toBe(false);
  });
});

describe("GitHubCredential", () => {
  it("gives one call an env with GH_TOKEN set, leaving process.env and the base untouched", () => {
    const before = process.env.GH_TOKEN;
    const base = { PATH: "/usr/bin", GITHUB_TOKEN: "ambient", GH_ENTERPRISE_TOKEN: "ambient-ghe" };
    const cred = new GitHubCredential("example-bot", FAKE_TOKEN);

    const env = cred.env(base);

    expect(env.GH_TOKEN).toBe(FAKE_TOKEN);
    expect(env.PATH).toBe("/usr/bin");
    // Only the chosen account's token: no ambient token can win instead.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(base).toEqual({ PATH: "/usr/bin", GITHUB_TOKEN: "ambient", GH_ENTERPRISE_TOKEN: "ambient-ghe" });
    expect(process.env.GH_TOKEN).toBe(before);
  });

  it("defaults the base env to a copy of process.env", () => {
    const cred = new GitHubCredential("example-bot", FAKE_TOKEN);
    const env = cred.env();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env).not.toBe(process.env);
    expect(process.env.GH_TOKEN).not.toBe(FAKE_TOKEN);
  });

  it("never shows the token when serialized, inspected or stringified", () => {
    const cred = new GitHubCredential("example-bot", FAKE_TOKEN);
    expect(JSON.stringify(cred)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify({ nested: cred })).toContain("example-bot");
    expect(inspect(cred, { showHidden: true, depth: 5 })).not.toContain(FAKE_TOKEN);
    expect(String(cred)).not.toContain(FAKE_TOKEN);
    expect(`${cred}`).toContain("example-bot");
    expect(Object.values(cred)).not.toContain(FAKE_TOKEN);
  });

  it("redacts the token from text such as a CLI error", () => {
    const cred = new GitHubCredential("example-bot", FAKE_TOKEN);
    expect(cred.redact(`bad credentials: ${FAKE_TOKEN} (${FAKE_TOKEN})`)).toBe("bad credentials: ●●●● (●●●●)");
  });

  it("names the per-command git config that makes gh answer git's credential requests", () => {
    expect(GH_GIT_CREDENTIAL_ARGS).toEqual(["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]);
  });
});

describe("withoutGitHubAccess", () => {
  it("removes every GitHub token variable and points GH_CONFIG_DIR at the given directory", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin", HOME: "/home/example", GH_CONFIG_DIR: "/home/example/.config/gh" };
    for (const name of GITHUB_TOKEN_ENV_VARS) env[name] = "ambient";

    const isolated = withoutGitHubAccess(env, "/tmp/empty-gh");

    for (const name of GITHUB_TOKEN_ENV_VARS) expect(isolated).not.toHaveProperty(name);
    expect(isolated.GH_CONFIG_DIR).toBe("/tmp/empty-gh");
    expect(isolated.PATH).toBe("/usr/bin");
    expect(isolated.HOME).toBe("/home/example");
    // The input is not changed.
    expect(env.GH_TOKEN).toBe("ambient");
  });

  it("lists the four token variables gh and git read", () => {
    expect([...GITHUB_TOKEN_ENV_VARS].sort()).toEqual(["GH_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITHUB_TOKEN"]);
  });
});

describe("empty gh config directories", () => {
  const made: string[] = [];
  afterEach(() => { made.length = 0; });

  it("creates a fresh, empty directory each time", () => {
    const a = createEmptyGhConfigDir();
    const b = createEmptyGhConfigDir();
    made.push(a, b);
    expect(a).not.toBe(b);
    for (const dir of [a, b]) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it("gives backends with no configured directory one shared default", () => {
    const first = defaultWorkerGhConfigDir();
    expect(defaultWorkerGhConfigDir()).toBe(first);
    expect(readdirSync(first)).toEqual([]);
  });
});

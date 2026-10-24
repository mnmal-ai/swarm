/**
 * source_control.github_account at `swarm run` start: resolve the account's
 * token from gh, check it belongs to the account and that the account can see
 * the work repo's remote, check the commit identity's noreply address, and
 * produce the preflight banner's GitHub line. Without the setting, the banner
 * names gh's active account.
 *
 * Every command goes through an injected fake runner: gh and git never run,
 * no real token is read, and none is ever printed.
 */

import { describe, it, expect } from "vitest";
import type { ProjectConfig } from "@mnmal-ai/swarm-types";
import {
  checkGitHubAccount,
  describeActiveGitHubAccount,
  formatGitHubBannerLine,
  prepareGitHubAccess,
  swarmWillUseGh,
  redactRemoteUrl,
} from "../src/cli/github-account.js";
import type { CommandRunner } from "../src/external-deps.js";

const FAKE_TOKEN = "gho_FAKE0000000000000000000000000000test";
const LOGIN = "example-bot";
const USER_ID = 4242;

interface Call {
  file: string;
  args: string[];
  cwd?: string;
  token?: string;
  processToken?: string;
}

interface FakeGh {
  /** stdout of `gh auth token --user <login>`, or an error to throw. */
  token?: string | Error;
  /** JSON of `gh api user` (with the account's token). */
  user?: { login: string; id: number } | Error;
  /** JSON of `gh api user` with no token override (the active account). */
  activeUser?: { login: string; id: number } | Error;
  remoteUrl?: string | Error;
  repoVisible?: true | Error;
  version?: string;
}

function failure(stderr: string, code?: string): Error {
  return Object.assign(new Error(`Command failed\n${stderr}`), { stderr, ...(code ? { code } : {}) });
}

function fakeRunner(fake: FakeGh, calls: Call[] = []): CommandRunner {
  return async (file, args, options) => {
    calls.push({ file, args: [...args], cwd: options?.cwd, token: options?.env?.GH_TOKEN, processToken: process.env.GH_TOKEN });
    const answer = (value: unknown): string => {
      if (value instanceof Error) throw value;
      if (value === undefined) throw failure("unexpected call");
      return typeof value === "string" ? value : JSON.stringify(value);
    };
    if (file === "gh" && args[0] === "--version") return answer(fake.version ?? "gh version 2.63.0 (2026-01-01)\n");
    if (file === "gh" && args[0] === "auth" && args[1] === "token") return answer(fake.token);
    if (file === "gh" && args[0] === "api" && args[1] === "user") {
      return answer(options?.env?.GH_TOKEN ? fake.user : fake.activeUser);
    }
    if (file === "gh" && args[0] === "api" && args[1]?.startsWith("repos/")) return answer(fake.repoVisible === true ? "{}" : fake.repoVisible);
    if (file === "git" && args[0] === "remote") return answer(fake.remoteUrl);
    throw failure(`unexpected command ${file} ${args.join(" ")}`);
  };
}

const HAPPY: FakeGh = {
  token: `${FAKE_TOKEN}\n`,
  user: { login: LOGIN, id: USER_ID },
  remoteUrl: "git@work-alias:example-org/sample-app.git\n",
  repoVisible: true,
};

const INPUT = { login: LOGIN, repoRoot: "/work/sample-app", remote: "origin" };

describe("checkGitHubAccount", () => {
  it("resolves the token once, confirms the account, and finds the repo from the remote", async () => {
    const calls: Call[] = [];
    const result = await checkGitHubAccount(INPUT, fakeRunner(HAPPY, calls));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repo).toBe("example-org/sample-app");
    expect(result.credential.login).toBe(LOGIN);
    expect(result.credential.env({}).GH_TOKEN).toBe(FAKE_TOKEN);
    expect(result.warnings).toEqual([]);

    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual([
      "gh auth token --user example-bot",
      "gh api user",
      "git remote get-url origin",
      "gh api repos/example-org/sample-app",
    ]);
    // The token reaches only the gh calls made as the account, per call.
    expect(calls.map((c) => c.token)).toEqual([undefined, FAKE_TOKEN, undefined, FAKE_TOKEN]);
    expect(calls[2].cwd).toBe("/work/sample-app");
    for (const call of calls) expect(call.processToken).not.toBe(FAKE_TOKEN);
    expect(process.env.GH_TOKEN).not.toBe(FAKE_TOKEN);
  });

  it.each([
    ["an https remote", "https://github.com/example-org/sample-app.git"],
    ["an ssh:// remote", "ssh://git@github.com/example-org/sample-app.git"],
    ["an scp-style remote", "git@github.com:example-org/sample-app"],
  ])("reads the repo from %s", async (_label, remoteUrl) => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, remoteUrl }));
    expect(result.ok && result.repo).toBe("example-org/sample-app");
  });

  it("checks the configured remote name", async () => {
    const calls: Call[] = [];
    await checkGitHubAccount({ ...INPUT, remote: "upstream" }, fakeRunner(HAPPY, calls));
    expect(calls.find((c) => c.file === "git")?.args).toEqual(["remote", "get-url", "upstream"]);
  });

  it("fails when gh is not installed", async () => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, token: failure("", "ENOENT") }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/source_control\.github_account is "example-bot", but gh is not installed/);
  });

  it("fails when the account is not logged in to gh", async () => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, token: failure("no oauth token found for github.com account example-bot") }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/source_control\.github_account is "example-bot", but gh has no login for it/);
    expect(!result.ok && result.error).toMatch(/gh auth login/);
  });

  it("fails when gh prints no token", async () => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, token: "\n" }));
    expect(!result.ok && result.error).toMatch(/gh has no login for it/);
  });

  it("fails when GitHub will not confirm the token, without printing it", async () => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, user: failure(`HTTP 401: Bad credentials (token ${FAKE_TOKEN})`) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/GitHub did not accept the token gh holds for "example-bot"/);
    expect(result.error).toMatch(/HTTP 401: Bad credentials/);
    expect(result.error).not.toContain(FAKE_TOKEN);
  });

  it("fails when the token belongs to another account", async () => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, user: { login: "someone-else", id: 7 } }));
    expect(!result.ok && result.error).toMatch(/the token gh holds for "example-bot" belongs to "someone-else"/);
  });

  it("fails when the work repo has no such remote", async () => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, remoteUrl: failure("error: No such remote 'origin'") }));
    expect(!result.ok && result.error).toMatch(/the work repo \(\/work\/sample-app\) has no "origin" remote/);
  });

  it("fails when the remote names no owner/repo, without printing credentials in its URL", async () => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, remoteUrl: `https://x-access-token:${FAKE_TOKEN}@github.com/example-org\n` }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/the "origin" remote \(https:\/\/github\.com\/example-org\) does not name a GitHub repository/);
    expect(result.error).not.toContain(FAKE_TOKEN);
  });

  it("fails when the account cannot see the repo", async () => {
    const result = await checkGitHubAccount(INPUT, fakeRunner({ ...HAPPY, repoVisible: failure("gh: Not Found (HTTP 404)") }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/"example-bot" cannot see example-org\/sample-app \(the work repo's "origin" remote\)/);
    expect(result.error).toMatch(/Not Found \(HTTP 404\)/);
  });

  describe("git_identity.email", () => {
    it.each([
      `${USER_ID}+${LOGIN}@users.noreply.github.com`,
      `${LOGIN}@users.noreply.github.com`,
      "Example-Bot@users.noreply.github.com",
      "bot@example.com",
    ])("accepts %s without a warning", async (email) => {
      const result = await checkGitHubAccount({ ...INPUT, gitIdentityEmail: email }, fakeRunner(HAPPY));
      expect(result.ok && result.warnings).toEqual([]);
    });

    it.each([
      [`999+someone-else@users.noreply.github.com`, /noreply address of "someone-else", not of "example-bot"/],
      [`someone-else@users.noreply.github.com`, /noreply address of "someone-else", not of "example-bot"/],
      [`1+${LOGIN}@users.noreply.github.com`, /carries user id 1, but "example-bot" is 4242/],
    ])("warns, but does not fail, for %s", async (email, message) => {
      const result = await checkGitHubAccount({ ...INPUT, gitIdentityEmail: email }, fakeRunner(HAPPY));
      expect(result.ok).toBe(true);
      expect(result.ok && result.warnings.join("\n")).toMatch(message);
    });
  });
});

describe("describeActiveGitHubAccount", () => {
  it("names gh's active account", async () => {
    const calls: Call[] = [];
    const status = await describeActiveGitHubAccount(fakeRunner({ activeUser: { login: "someone-active", id: 1 } }, calls));
    expect(status).toEqual({ kind: "active", login: "someone-active" });
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBeUndefined();
  });

  it("says when gh is not logged in", async () => {
    expect(await describeActiveGitHubAccount(fakeRunner({ activeUser: failure("not logged in") }))).toEqual({ kind: "not-logged-in" });
  });

  it("says when gh is not installed", async () => {
    expect(await describeActiveGitHubAccount(fakeRunner({ activeUser: failure("", "ENOENT") }))).toEqual({ kind: "not-installed" });
  });
});

describe("formatGitHubBannerLine", () => {
  it("with the setting: the account, a check, and the repo", () => {
    expect(formatGitHubBannerLine({ kind: "configured", login: LOGIN, repo: "example-org/sample-app" }))
      .toBe("GitHub      example-bot ✓ example-org/sample-app");
  });

  it("without it: gh's active account, marked as such", () => {
    expect(formatGitHubBannerLine({ kind: "active", login: "someone-active" }))
      .toBe("GitHub      someone-active (gh's active account)");
  });

  it("without it and no login: not logged in", () => {
    expect(formatGitHubBannerLine({ kind: "not-logged-in" })).toBe("GitHub      not logged in");
    expect(formatGitHubBannerLine({ kind: "not-installed" })).toBe("GitHub      gh not installed");
  });

  it("colours through the painter it is given", () => {
    const paint = { ok: (s: string) => `<ok>${s}</ok>`, dim: (s: string) => `<dim>${s}</dim>`, warn: (s: string) => `<warn>${s}</warn>` };
    expect(formatGitHubBannerLine({ kind: "configured", login: LOGIN, repo: "example-org/sample-app" }, paint))
      .toBe("GitHub      example-bot <ok>✓</ok> <dim>example-org/sample-app</dim>");
    expect(formatGitHubBannerLine({ kind: "not-logged-in" }, paint)).toBe("GitHub      <warn>not logged in</warn>");
  });
});

describe("swarmWillUseGh", () => {
  const base = { task_backend: "local" } as Pick<ProjectConfig, "task_backend" | "taskBackendConfig" | "source_control">;
  it("is true with a github_account, the GitHub task backend, or remote_pr", () => {
    expect(swarmWillUseGh({ ...base, source_control: { strategy: "ephemeral", github_account: LOGIN } })).toBe(true);
    expect(swarmWillUseGh({ ...base, task_backend: "github" })).toBe(true);
    expect(swarmWillUseGh({ ...base, taskBackendConfig: { type: "github" } as ProjectConfig["taskBackendConfig"] })).toBe(true);
    expect(swarmWillUseGh({ ...base, source_control: { strategy: "remote_pr" } })).toBe(true);
  });
  it("is false for a local run that pushes nothing", () => {
    expect(swarmWillUseGh(base)).toBe(false);
    expect(swarmWillUseGh({ ...base, source_control: { strategy: "local_branch" } })).toBe(false);
  });
});

describe("prepareGitHubAccess", () => {
  const config = (sc: ProjectConfig["source_control"]) =>
    ({ task_backend: "local", source_control: sc }) as Pick<ProjectConfig, "task_backend" | "taskBackendConfig" | "source_control">;

  it("with the setting: runs the check and returns the credential and banner", async () => {
    const result = await prepareGitHubAccess(config({ strategy: "remote_pr", github_account: LOGIN }), "/work/sample-app", fakeRunner(HAPPY));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential?.login).toBe(LOGIN);
    expect(result.banner).toEqual({ kind: "configured", login: LOGIN, repo: "example-org/sample-app" });
    expect(result.warnings).toEqual([]);
  });

  it("with the setting and a failing check: an error, and no credential", async () => {
    const result = await prepareGitHubAccess(
      config({ strategy: "remote_pr", github_account: LOGIN }),
      "/work/sample-app",
      fakeRunner({ ...HAPPY, token: failure("no oauth token") }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/gh has no login for it/);
  });

  it("warns when gh's installed major differs from the tested one", async () => {
    const result = await prepareGitHubAccess(
      config({ strategy: "remote_pr", github_account: LOGIN }),
      "/work/sample-app",
      fakeRunner({ ...HAPPY, version: "gh version 3.0.0 (2027-01-01)\n" }),
    );
    expect(result.warnings.join("\n")).toMatch(/gh 3\.0\.0 is installed, but swarm is tested with gh 2\.x/);
  });

  it("does not check gh's version when the run will not use gh", async () => {
    const calls: Call[] = [];
    await prepareGitHubAccess(config({ strategy: "ephemeral" }), "/work/sample-app", fakeRunner({ activeUser: { login: "someone-active", id: 1 } }, calls));
    expect(calls.some((c) => c.args[0] === "--version")).toBe(false);
  });

  it("without the setting: no credential, and the banner names the active account", async () => {
    const result = await prepareGitHubAccess(config({ strategy: "remote_pr" }), "/work/sample-app", fakeRunner({ activeUser: { login: "someone-active", id: 1 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credential).toBeUndefined();
    expect(result.banner).toEqual({ kind: "active", login: "someone-active" });
  });
});

describe("redactRemoteUrl", () => {
  it("drops userinfo from a URL remote", () => {
    expect(redactRemoteUrl("https://x-access-token:secret@github.com/example-org/sample-app.git")).toBe("https://github.com/example-org/sample-app.git");
    expect(redactRemoteUrl("git@work-alias:example-org/sample-app.git")).toBe("git@work-alias:example-org/sample-app.git");
  });
});

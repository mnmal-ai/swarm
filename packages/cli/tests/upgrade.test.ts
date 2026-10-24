import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Nothing here reaches the network or runs gh, sudo, cp or codesign for real.
// `fetch` is a stub serving `apiReleases` (the releases API) and `published`
// (release assets at github.com/.../releases/download/<tag>/<asset>), or
// answering every URL with `anonymousStatus` the way github.com answers an
// anonymous caller for a private repository. gh goes through a mocked
// execFileSync: `gh release download` writes `published` assets into the -D
// directory as gh does, and `command -v swarm` answers with a temp file
// standing in for the installed CLI.
const calls: Array<{ cmd: string; args: string[] }> = [];
const fetched: string[] = [];
let ghListOutput = "";
let ghListThrows = false;
let ghMissing = false;
let ghUnauthed = false;
let anonymousStatus: number | null = null;
let anonymousHeaders: Record<string, string> = {};
const fetchInits: Array<RequestInit | undefined> = [];
let apiReleases: Array<Record<string, unknown>> = [];
let published: Record<string, Record<string, string>> = {};
let installedPath = "";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

vi.mock("node:child_process", () => ({
  execFileSync: (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === "sh" && args[1] === "command -v swarm") return installedPath;
    if (cmd === "sh" && args.includes("gh")) {
      if (ghMissing) throw new Error("not found");
      return "/opt/bin/gh";
    }
    if (cmd !== "gh") return "";
    if (ghMissing) throw new Error("ENOENT");
    if (args[0] === "auth" && args[1] === "status") {
      if (ghUnauthed) throw new Error("not logged in");
      return "";
    }
    if (args[0] === "release" && args[1] === "list") {
      if (ghListThrows) throw new Error("gh: not logged in");
      return ghListOutput;
    }
    const tag = args[0] === "release" && args[1] === "view" ? args[2]! : flag(args, "--tag")!;
    if (args[1] === "view") return Object.keys(published[tag] ?? {}).join("\n");
    if (args[1] === "download") {
      const pattern = flag(args, "-p") as string;
      const content = published[tag]?.[pattern];
      if (content === undefined) throw new Error("no assets match the file pattern");
      writeFileSync(join(flag(args, "-D") as string, pattern), content);
      return "";
    }
    return "";
  },
}));

const log = { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() };
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log,
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

const { ghLatestReleaseTag, latestRelease, ReleaseAccessError, runUpgrade, upgradeAssetName } = await import(
  "../src/cli/upgrade.js"
);

const API = "https://api.github.com/repos/mnmal-ai/swarm/releases";
const DOWNLOAD = "https://github.com/mnmal-ai/swarm/releases/download";

async function fakeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  fetched.push(url);
  fetchInits.push(init);
  if (anonymousStatus !== null) return new Response("Not Found", { status: anonymousStatus, headers: anonymousHeaders });
  if (url.startsWith(`${API}?`)) {
    return new Response(JSON.stringify(apiReleases), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith(`${DOWNLOAD}/`)) {
    const [tag, asset] = url.slice(DOWNLOAD.length + 1).split("/");
    const content = published[tag!]?.[asset!];
    if (content !== undefined) return new Response(content, { status: 200 });
  }
  return new Response("Not Found", { status: 404 });
}

let dir: string;
let tmp: string;
const savedTmpdir = process.env.TMPDIR;

beforeEach(() => {
  calls.length = 0;
  fetched.length = 0;
  ghListOutput = "";
  ghListThrows = false;
  ghMissing = false;
  ghUnauthed = false;
  anonymousStatus = null;
  anonymousHeaders = {};
  fetchInits.length = 0;
  apiReleases = [];
  published = {};
  dir = mkdtempSync(join(tmpdir(), "swarm-upgrade-test-"));
  // runUpgrade makes its download directory under os.tmpdir(): here, so the
  // tests can see whether it is left behind.
  tmp = join(dir, "tmp");
  mkdirSync(tmp);
  process.env.TMPDIR = tmp;
  installedPath = join(dir, "swarm");
  writeFileSync(installedPath, "old-binary");
  for (const fn of Object.values(log)) fn.mockClear();
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const ghReleases = (...list: Array<{ tagName: string; isDraft?: boolean }>) =>
  JSON.stringify(list.map((r) => ({ tagName: r.tagName, isDraft: r.isDraft ?? false })));
const apiRelease = (tag: string, draft = false) => ({ tag_name: tag, draft, prerelease: true });
const ghCalls = () => calls.filter((c) => c.cmd === "gh" || (c.cmd === "sh" && c.args.includes("gh")));

function exitThrows() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
}

describe("latestRelease: the releases API anonymously, gh only as a fallback", () => {
  it("reads the newest published release from the API without gh", async () => {
    apiReleases = [apiRelease("v1.0.0-alpha.4", true), apiRelease("v1.0.0-alpha.3"), apiRelease("v1.0.0-alpha.2")];
    expect(await latestRelease()).toEqual({ tag: "v1.0.0-alpha.3", via: "anonymous" });
    expect(fetched[0]).toMatch(/^https:\/\/api\.github\.com\/repos\/mnmal-ai\/swarm\/releases\?per_page=\d+$/);
    expect(ghCalls()).toEqual([]);
  });

  it("is null when there is no published release", async () => {
    apiReleases = [];
    expect(await latestRelease()).toEqual({ tag: null, via: "anonymous" });
  });

  it.each([404, 403])("falls back to a logged-in gh when the API answers %s", async (status) => {
    anonymousStatus = status;
    ghListOutput = ghReleases({ tagName: "v1.0.0-alpha.5", isDraft: true }, { tagName: "v1.0.0-alpha.4" });
    expect(await latestRelease()).toEqual({ tag: "v1.0.0-alpha.4", via: "gh" });
  });

  it("without gh, a 404 is a clear error naming the status and gh auth login", async () => {
    anonymousStatus = 404;
    ghMissing = true;
    const err = await latestRelease().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseAccessError);
    expect(String((err as Error).message)).toContain("HTTP 404");
    expect(String((err as Error).message)).toContain("gh auth login");
  });

  it("says a 403 with no rate limit left is the rate limit, with the wait, and does not reach for gh", async () => {
    anonymousStatus = 403;
    anonymousHeaders = {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
    };
    const err = (await latestRelease().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ReleaseAccessError);
    expect(err.message).toMatch(/GitHub API rate limit reached/);
    expect(err.message).toMatch(/retry in (9|10) minutes/);
    expect(err.message).toContain("GH_TOKEN");
    expect(err.message).not.toMatch(/install gh|gh auth login/);
    expect(calls.filter((c) => c.cmd === "gh")).toEqual([]);
  });

  it("treats a 429 as the rate limit too, using retry-after", async () => {
    anonymousStatus = 429;
    anonymousHeaders = { "retry-after": "120" };
    await expect(latestRelease()).rejects.toThrow(/rate limit reached: retry in 2 minutes/);
  });

  it("sends GH_TOKEN to the releases API when it is set, and nothing otherwise", async () => {
    apiReleases = [apiRelease("v1.0.0-alpha.3")];
    const saved = process.env.GH_TOKEN;
    try {
      delete process.env.GH_TOKEN;
      await latestRelease();
      expect(new Headers(fetchInits[0]?.headers).get("authorization")).toBeNull();
      process.env.GH_TOKEN = "test-token";
      await latestRelease();
      expect(new Headers(fetchInits[1]?.headers).get("authorization")).toBe("Bearer test-token");
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });

  it("does not fall back to a gh that is not logged in, or on a server error", async () => {
    anonymousStatus = 404;
    ghUnauthed = true;
    await expect(latestRelease()).rejects.toBeInstanceOf(ReleaseAccessError);
    ghUnauthed = false;
    anonymousStatus = 500;
    await expect(latestRelease()).rejects.toThrow(/HTTP 500/);
    expect(calls.filter((c) => c.cmd === "gh" && c.args[1] === "list")).toEqual([]);
  });
});

describe("ghLatestReleaseTag", () => {
  it("picks the newest non-draft tag from gh's list", async () => {
    ghListOutput = ghReleases({ tagName: "v1.0.0-alpha.3" }, { tagName: "v1.0.0-alpha.2" });
    expect(await ghLatestReleaseTag()).toBe("v1.0.0-alpha.3");
    const list = calls.find((c) => c.cmd === "gh" && c.args[1] === "list");
    expect(list?.args).toEqual([
      "release", "list", "--repo", "mnmal-ai/swarm", "--limit", "20", "--json", "tagName,isDraft",
    ]);
  });

  it("skips draft releases", async () => {
    ghListOutput = ghReleases(
      { tagName: "v1.0.0-alpha.5", isDraft: true },
      { tagName: "v1.0.0-alpha.4", isDraft: true },
      { tagName: "v1.0.0-alpha.3" },
    );
    expect(await ghLatestReleaseTag()).toBe("v1.0.0-alpha.3");
    ghListOutput = ghReleases({ tagName: "v1.0.0-alpha.5", isDraft: true });
    expect(await ghLatestReleaseTag()).toBeNull();
  });

  it("returns null when the list is empty or unreadable, or gh fails", async () => {
    for (const out of ["[]\n", "\n", "null\n"]) {
      ghListOutput = out;
      expect(await ghLatestReleaseTag()).toBeNull();
    }
    ghListThrows = true;
    expect(await ghLatestReleaseTag()).toBeNull();
  });
});

describe("upgradeAssetName: the binary for this machine", () => {
  const flags = (...f: string[]) => () => `processor\t: 0\nflags\t\t: fpu sse2 ${f.join(" ")}\n`;

  it("names the platform build", () => {
    expect(upgradeAssetName("darwin", "arm64")).toBe("swarm-darwin-arm64");
    expect(upgradeAssetName("darwin", "x64")).toBe("swarm-darwin-x64");
    expect(upgradeAssetName("linux", "arm64")).toBe("swarm-linux-arm64");
    expect(upgradeAssetName("win32", "x64")).toBeNull();
    expect(upgradeAssetName("linux", "ia32")).toBeNull();
  });

  it("picks the baseline build on Linux x64 without AVX2, as the installer does", () => {
    expect(upgradeAssetName("linux", "x64", flags("avx", "avx2", "bmi2"))).toBe("swarm-linux-x64");
    expect(upgradeAssetName("linux", "x64", flags("avx", "avx512f"))).toBe("swarm-linux-x64-baseline");
    expect(
      upgradeAssetName("linux", "x64", () => {
        throw new Error("ENOENT");
      }),
    ).toBe("swarm-linux-x64-baseline");
  });
});

describe("runUpgrade", () => {
  const NEW = "new-binary-bytes";
  const TAG = "v99.0.0";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  // The asset runUpgrade picks for this machine.
  const asset = upgradeAssetName() as string;
  const release = (checksum: string | null = sha(NEW)) => {
    published = { [TAG]: { [asset]: NEW, ...(checksum === null ? {} : { [`${asset}.sha256`]: `${checksum}  ${asset}\n` }) } };
  };

  beforeEach(() => {
    apiReleases = [apiRelease(TAG)];
    ghListOutput = ghReleases({ tagName: TAG });
  });

  it("downloads and verifies anonymously from github.com, with no gh at all", async () => {
    release();
    ghMissing = true;
    const exit = exitThrows();
    await runUpgrade({});
    expect(exit).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(readFileSync(installedPath, "utf-8")).toBe(NEW);
    expect(fetched).toContain(`${DOWNLOAD}/${TAG}/${asset}`);
    expect(fetched).toContain(`${DOWNLOAD}/${TAG}/${asset}.sha256`);
    expect(calls.filter((c) => c.cmd === "gh")).toEqual([]);
    expect(log.success.mock.calls.map((c) => String(c[0]))).toContain("Checksum verified");
  });

  it("downloads a --version tag directly, without asking the releases API", async () => {
    release();
    exitThrows();
    await runUpgrade({ version: TAG });
    expect(fetched.some((u) => u.startsWith(API))).toBe(false);
    expect(readFileSync(installedPath, "utf-8")).toBe(NEW);
  });

  it("refuses a mismatch, naming both digests, and leaves the installed binary untouched", async () => {
    const wrong = "f".repeat(64);
    release(wrong);
    const exit = exitThrows();
    await expect(runUpgrade({})).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    const message = log.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toContain(wrong);
    expect(message).toContain(sha(NEW));
    expect(readFileSync(installedPath, "utf-8")).toBe("old-binary");
    expect(calls.filter((c) => c.cmd === "sudo" || c.cmd === "codesign")).toEqual([]);
  });

  // process.exit skips `finally`, so the download directory (with the rejected
  // binary in it) must already be gone when exit is called. The stub records
  // what is left at that moment, then throws so the test can continue.
  function exitRecordingLeftovers(): { leftover: string[] | null } {
    const seen: { leftover: string[] | null } = { leftover: null };
    vi.spyOn(process, "exit").mockImplementation((() => {
      seen.leftover ??= readdirSync(tmp).filter((n) => n.startsWith("swarm-upgrade-"));
      throw new Error("process.exit");
    }) as never);
    return seen;
  }

  it("removes its download directory before exiting on a mismatch", async () => {
    release("f".repeat(64));
    const seen = exitRecordingLeftovers();
    await expect(runUpgrade({})).rejects.toThrow("process.exit");
    expect(seen.leftover).toEqual([]);
  });

  it("removes its download directory before exiting when the download is refused", async () => {
    release();
    anonymousStatus = 404;
    ghMissing = true;
    const seen = exitRecordingLeftovers();
    await expect(runUpgrade({ version: TAG })).rejects.toThrow("process.exit");
    expect(seen.leftover).toEqual([]);
  });

  it("stops on a rate-limited asset download with the rate-limit message, binary untouched", async () => {
    release();
    anonymousStatus = 429;
    anonymousHeaders = { "retry-after": "60" };
    const exit = exitThrows();
    await expect(runUpgrade({ version: TAG })).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    const message = log.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toMatch(/rate limit reached: retry in 1 minute/);
    expect(message).not.toMatch(/gh auth login/);
    expect(readFileSync(installedPath, "utf-8")).toBe("old-binary");
  });

  it("refuses a .sha256 that holds no digest, binary untouched", async () => {
    published = { [TAG]: { [asset]: NEW, [`${asset}.sha256`]: "not a digest\n" } };
    const exit = exitThrows();
    await expect(runUpgrade({ version: TAG })).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("holds no SHA-256 digest");
    expect(readFileSync(installedPath, "utf-8")).toBe("old-binary");
  });

  // The binary came anonymously, so the repository is public: a .sha256 that
  // github.com then refuses (403) or rate-limits cannot be verified, and stops
  // the upgrade. (A 404 means the release has no .sha256: the warning case.)
  it.each([
    ["403", {}, /HTTP 403 for .*\.sha256.*cannot be verified/],
    ["403, rate limited", { "x-ratelimit-remaining": "0" }, /rate limit reached/],
  ] as const)("stops when the .sha256 download is refused (%s) after the binary arrived", async (_name, headers, message) => {
    release();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        fetched.push(url);
        if (url.endsWith(".sha256")) return new Response("Forbidden", { status: 403, headers });
        return fakeFetch(url);
      }),
    );
    const exit = exitThrows();
    await expect(runUpgrade({ version: TAG })).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(message);
    expect(readFileSync(installedPath, "utf-8")).toBe("old-binary");
    expect(calls.filter((c) => c.cmd === "gh")).toEqual([]);
  });

  it("installs with a warning when the release has no .sha256 asset", async () => {
    release(null);
    const exit = exitThrows();
    await runUpgrade({});
    expect(exit).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(`${asset}.sha256`);
    expect(readFileSync(installedPath, "utf-8")).toBe(NEW);
  });

  it("falls back to a logged-in gh when github.com answers 404, and still verifies", async () => {
    release();
    anonymousStatus = 404;
    const exit = exitThrows();
    await runUpgrade({});
    expect(exit).not.toHaveBeenCalled();
    expect(readFileSync(installedPath, "utf-8")).toBe(NEW);
    const downloads = calls.filter((c) => c.cmd === "gh" && c.args[1] === "download");
    expect(downloads.map((c) => flag(c.args, "-p"))).toEqual([asset, `${asset}.sha256`]);
    // The checksum goes into its own directory, not over the binary.
    expect(flag(downloads[1]!.args, "-D")).not.toBe(flag(downloads[0]!.args, "-D"));
    expect(log.success.mock.calls.map((c) => String(c[0]))).toContain("Checksum verified");
  });

  it("falls back to gh for the download when only the asset URL is refused", async () => {
    release();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        fetched.push(url);
        return url.startsWith(API)
          ? new Response(JSON.stringify(apiReleases), { status: 200 })
          : new Response("Not Found", { status: 404 });
      }),
    );
    exitThrows();
    await runUpgrade({});
    expect(readFileSync(installedPath, "utf-8")).toBe(NEW);
    expect(calls.some((c) => c.cmd === "gh" && c.args[1] === "download")).toBe(true);
  });

  it("without gh, a 404 stops with a clear error and leaves the binary alone", async () => {
    release();
    anonymousStatus = 404;
    ghMissing = true;
    const exit = exitThrows();
    await expect(runUpgrade({ version: TAG })).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    const message = log.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toContain("HTTP 404");
    expect(message).toContain("gh auth login");
    expect(readFileSync(installedPath, "utf-8")).toBe("old-binary");
  });

  it("exits 1 and leaves the binary alone when there are no releases", async () => {
    apiReleases = [];
    const exit = exitThrows();
    await expect(runUpgrade({})).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalled();
    expect(readFileSync(installedPath, "utf-8")).toBe("old-binary");
    expect(calls.filter((c) => c.cmd === "sudo" || c.cmd === "codesign" || c.cmd === "gh")).toEqual([]);
  });
});

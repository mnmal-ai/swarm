/**
 * swarm upgrade — Upgrade the swarm CLI to the latest (or a specific) version.
 *
 * Downloads the platform binary from a GitHub release, the way
 * scripts/install.sh does: anonymously from github.com first (the releases API
 * for the newest tag, github.com/<repo>/releases/download/<tag>/<asset> for
 * the binary and its .sha256), and through `gh` only when github.com refuses
 * an anonymous request (HTTP 404 or 403, as it answers for a private
 * repository) and gh is installed and logged in. No package is published to
 * npm, so there is no other fallback: without a reachable release the command
 * stops and leaves the installed binary alone.
 *
 * Releases are prereleases while the version line is 1.0.0-alpha.N, and
 * GitHub's "latest release" endpoint ignores prereleases, so the newest tag
 * is the first non-draft entry of the release list.
 *
 * The downloaded binary is checked against the release's `<asset>.sha256`
 * before it replaces the installed one; a mismatch stops the upgrade with the
 * installed binary untouched. Only a release with no `.sha256` asset (an older
 * one) installs unverified, with a warning.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { VERSION } from "../version.js";

let p: typeof import("@clack/prompts");
let pc: typeof import("picocolors");

const REPO = "mnmal-ai/swarm";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
const RELEASE_DOWNLOAD = `https://github.com/${REPO}/releases/download`;
const HTTP_TIMEOUT_MS = 300_000;

// Validate version string: only allow semver-like patterns (v1.2.3, 1.2.3, v1.2.3-beta.1)
export const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;

function runFile(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

/**
 * Run a command with stdio inherited so sudo can prompt via the TTY and
 * the password cache is visible. Returns true on success, false on failure.
 */
function runInherit(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

function hasCommand(name: string): boolean {
  try {
    execFileSync("sh", ["-c", "command -v \"$1\"", "--", name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip a leading `v` and trim whitespace from a version-ish string so
 * "v0.35.0\n" and "0.35.0" compare equal to the bundled VERSION constant.
 */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/, "");
}

/** Whether gh is installed and logged in (the fallback when github.com refuses anonymous requests). */
function ghReady(): boolean {
  if (!hasCommand("gh")) return false;
  try {
    runFile("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

/** github.com could not serve the release: nothing was changed. The message says why and what to do. */
export class ReleaseAccessError extends Error {
  override readonly name = "ReleaseAccessError";
}

/** The error for an anonymous request github.com refused when gh cannot stand in. */
function refusedWithoutGh(status: number, what: string): ReleaseAccessError {
  return new ReleaseAccessError(
    `github.com answered HTTP ${status} for ${what} without credentials. If the repository is private, ` +
      "install gh (https://cli.github.com), run `gh auth login`, and retry. The installed binary was not changed.",
  );
}

/**
 * GitHub's rate limit, not a private repository: a 429, or a 403 with no
 * requests left (`x-ratelimit-remaining: 0`). The error says how long to wait
 * (`x-ratelimit-reset`, else `retry-after`) and that GH_TOKEN lifts the limit;
 * it never sends the user to install gh. Null for any other response.
 */
function rateLimitError(res: Response): ReleaseAccessError | null {
  const limited =
    res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining")?.trim() === "0");
  if (!limited) return null;
  let waitSeconds: number | null = null;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(res.headers.get("retry-after"));
  if (res.headers.get("x-ratelimit-reset") !== null && Number.isFinite(reset)) waitSeconds = reset - Date.now() / 1000;
  else if (res.headers.get("retry-after") !== null && Number.isFinite(retryAfter)) waitSeconds = retryAfter;
  const minutes = waitSeconds === null ? null : Math.max(1, Math.ceil(waitSeconds / 60));
  const when = minutes === null ? "retry later" : `retry in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return new ReleaseAccessError(
    `GitHub API rate limit reached: ${when}, or set GH_TOKEN. The installed binary was not changed.`,
  );
}

/** First non-draft tag in a newest-first release list, or null. */
function firstPublished(list: unknown, tagKey: string, draftKey: string): string | null {
  if (!Array.isArray(list)) return null;
  for (const release of list as Array<Record<string, unknown>>) {
    if (release?.[draftKey] === true) continue;
    const tag = release?.[tagKey];
    if (typeof tag === "string" && tag !== "") return tag;
  }
  return null;
}

/**
 * The newest published release tag (prereleases included, drafts skipped)
 * from `gh release list`, which is newest-first and lists drafts to anyone who
 * can see them. Null when there is none, or when gh fails.
 */
export async function ghLatestReleaseTag(): Promise<string | null> {
  try {
    const out = runFile("gh", [
      "release", "list", "--repo", REPO, "--limit", "20", "--json", "tagName,isDraft",
    ]);
    return firstPublished(JSON.parse(out || "[]"), "tagName", "isDraft");
  } catch {
    return null;
  }
}

/** How the release is being read: anonymously from github.com, or through gh. */
export type ReleaseAccess = "anonymous" | "gh";

/**
 * The newest published release: the releases API anonymously (an anonymous
 * caller never sees drafts; they are skipped anyway), or gh's list when the
 * API answers 404/403 and gh is ready. `tag` is null when there is no
 * published release. Throws ReleaseAccessError when neither path can answer.
 */
export async function latestRelease(): Promise<{ tag: string | null; via: ReleaseAccess }> {
  let res: Response;
  try {
    // GH_TOKEN, when set, goes to the API only (it lifts the anonymous rate
    // limit); the release downloads stay anonymous.
    const token = process.env.GH_TOKEN?.trim();
    res = await fetch(`${RELEASES_API}?per_page=20`, {
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new ReleaseAccessError(
      `Could not reach the GitHub API (${err instanceof Error ? err.message : String(err)}). The installed binary was not changed.`,
    );
  }
  if (res.ok) {
    let list: unknown;
    try {
      list = await res.json();
    } catch {
      throw new ReleaseAccessError("The GitHub API's release list was not JSON. The installed binary was not changed.");
    }
    return { tag: firstPublished(list, "tag_name", "draft"), via: "anonymous" };
  }
  const limited = rateLimitError(res);
  if (limited !== null) throw limited;
  if (res.status === 404 || res.status === 403) {
    if (ghReady()) return { tag: await ghLatestReleaseTag(), via: "gh" };
    throw refusedWithoutGh(res.status, "the release list");
  }
  throw new ReleaseAccessError(`The GitHub API answered HTTP ${res.status} for the release list. The installed binary was not changed.`);
}

/**
 * Download asset `name` of release `tag` into `dir`. Anonymous: GET the
 * release download URL; "missing" on 404, `{ refused }` on a 403 that is not
 * the rate limit (so the caller can try gh); the rate limit throws. Through gh: list the release's assets ("missing" when `name` is
 * not among them), then `gh release download --clobber`. Any other failure
 * throws ReleaseAccessError.
 */
async function fetchAsset(
  name: string,
  tag: string,
  dir: string,
  via: ReleaseAccess,
): Promise<"ok" | "missing" | { refused: number }> {
  if (via === "gh") {
    let assets: string[];
    try {
      assets = runFile("gh", ["release", "view", tag, "--repo", REPO, "--json", "assets", "--jq", ".assets[].name"])
        .split("\n")
        .map((a) => a.trim());
    } catch {
      throw new ReleaseAccessError(
        `Could not list the assets of ${tag} through gh; check \`gh auth status\` and that the release exists. The installed binary was not changed.`,
      );
    }
    if (!assets.includes(name)) return "missing";
    try {
      runFile("gh", ["release", "download", "--repo", REPO, "--tag", tag, "-p", name, "-D", dir, "--clobber"]);
    } catch {
      throw new ReleaseAccessError(`Could not download ${name} from ${tag} through gh. The installed binary was not changed.`);
    }
    return "ok";
  }
  let res: Response;
  try {
    res = await fetch(`${RELEASE_DOWNLOAD}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ReleaseAccessError(
      `Could not download ${name} from github.com (${err instanceof Error ? err.message : String(err)}). The installed binary was not changed.`,
    );
  }
  const limited = rateLimitError(res);
  if (limited !== null) throw limited;
  if (res.status === 404) return "missing";
  if (res.status === 403) return { refused: 403 };
  if (!res.ok) {
    throw new ReleaseAccessError(`github.com answered HTTP ${res.status} for ${name} (${tag}). The installed binary was not changed.`);
  }
  writeFileSync(join(dir, name), Buffer.from(await res.arrayBuffer()));
  return "ok";
}

/**
 * The release asset for this machine: swarm-{darwin,linux}-{arm64,x64}, or
 * swarm-linux-x64-baseline on Linux x64 without AVX2 (Bun's standard x64
 * build needs it). As in scripts/install.sh, AVX2 comes from /proc/cpuinfo's
 * flags, and an unreadable cpuinfo means baseline. Null on other platforms.
 */
export function upgradeAssetName(
  platform: string = osPlatform(),
  cpu: string = osArch(),
  cpuinfo: () => string = () => readFileSync("/proc/cpuinfo", "utf-8"),
): string | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const arch = cpu === "arm64" ? "arm64" : cpu === "x64" ? "x64" : null;
  if (os === null || arch === null) return null;
  if (os === "linux" && arch === "x64") {
    let info = "";
    try {
      info = cpuinfo();
    } catch {
      /* unreadable: the baseline build is the safe choice */
    }
    if (!/\bavx2\b/.test(info)) return "swarm-linux-x64-baseline";
  }
  return `swarm-${os}-${arch}`;
}

/** Lowercase hex SHA-256 of a file. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The digest a release's `<asset>.sha256` holds (`<hex>  <asset>`, as
 * sha256sum writes it), lowercased, or null when the text holds no digest.
 */
export function parseChecksumFile(text: string): string | null {
  const digest = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

export type LaunchFailure =
  | { kind: "sigkill"; raw: string }
  | { kind: "other"; raw: string };

/**
 * Classify a failure from invoking the installed binary.
 *
 * AMFI kills unsigned arm64 executables with SIGKILL. Node surfaces that as
 * either `signal: "SIGKILL"` or `status: 137` (128 + signal 9). Detecting it
 * lets us print an actionable code-signing hint instead of a generic
 * "could not verify" warning that misdirects users toward the Gatekeeper
 * quarantine xattr — a different defense that does not apply here.
 */
export function classifyLaunchError(err: unknown): LaunchFailure {
  const e = err as { status?: number | null; signal?: NodeJS.Signals | string | null };
  if (e?.signal === "SIGKILL" || e?.status === 137 || e?.status === 9) {
    return { kind: "sigkill", raw: `signal=${e.signal ?? "null"} status=${e.status ?? "null"}` };
  }
  return { kind: "other", raw: err instanceof Error ? err.message : String(err) };
}

export async function runUpgrade(flags: Record<string, string>): Promise<void> {
  p = await import("@clack/prompts");
  pc = (await import("picocolors")).default;

  const targetVersion = flags["version"];

  // Validate version input
  if (targetVersion && !VERSION_PATTERN.test(targetVersion)) {
    p.log.error(`Invalid version: "${targetVersion}". Expected format: v1.2.3 or 1.2.3`);
    process.exit(1);
  }

  p.intro(pc.cyan("swarm upgrade"));
  p.log.info(`Current version: ${pc.bold(`swarm v${VERSION}`)}`);

  // Resolve the release to install. The implicit "latest" target is the
  // newest release including prereleases; an explicit `--version` is treated
  // as a deliberate (re)install request and skips the already-current check.
  let tag: string;
  let via: ReleaseAccess = "anonymous";
  if (targetVersion) {
    tag = targetVersion.startsWith("v") ? targetVersion : `v${targetVersion}`;
  } else {
    let latest: { tag: string | null; via: ReleaseAccess };
    try {
      latest = await latestRelease();
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (latest.tag === null) {
      p.log.error(`No published swarm release found in ${REPO}. The installed binary was not changed.`);
      process.exit(1);
    }
    tag = latest.tag;
    via = latest.via;
    if (normalizeVersion(tag) === VERSION) {
      p.log.success(`Already on the latest version (${pc.bold(`swarm v${VERSION}`)}).`);
      p.outro(pc.green("Nothing to do."));
      return;
    }
    p.log.info(`Latest available: ${pc.bold(tag)}`);
  }

  const { mkdtempSync, mkdirSync, rmSync, copyFileSync, chmodSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const assetName = upgradeAssetName();
  if (assetName === null) {
    p.log.error(`Unsupported platform: ${osPlatform()}-${osArch()}. Use the install script instead.`);
    process.exit(1);
  }
  const os = osPlatform() === "darwin" ? "darwin" : "linux";

  const downloadDir = mkdtempSync(join(tmpdir(), "swarm-upgrade-"));
  // process.exit skips `finally`: every failure below removes the download
  // directory (and the rejected binary in it) itself before exiting.
  const exitFailed: () => never = () => {
    rmSync(downloadDir, { recursive: true, force: true });
    return process.exit(1);
  };
  // Declared here (not inside the try) so it survives the try/finally
  // scope and is visible to reportResult(installPath) below.
  let installPath: string;

  try {
    p.log.info(`Target: ${pc.bold(tag)} (${assetName})`);

    const dlSpinner = p.spinner();
    dlSpinner.start("Downloading...");
    const fail: (message: string) => never = (message) => {
      dlSpinner.stop("Download failed");
      p.log.error(message);
      return exitFailed();
    };

    const download = async (): Promise<"ok" | "missing" | { refused: number }> => {
      try {
        return await fetchAsset(assetName, tag, downloadDir, via);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };
    let got = await download();
    // github.com refused the anonymous download (404 or 403, as it answers
    // for a private repository): continue through gh if it is ready.
    if (via === "anonymous" && got !== "ok") {
      const status = got === "missing" ? 404 : got.refused;
      if (!ghReady()) fail(refusedWithoutGh(status, `${assetName} (${tag})`).message);
      via = "gh";
      p.log.info(`github.com answered HTTP ${status} without credentials; using your gh login.`);
      got = await download();
    }
    if (got !== "ok") fail(`Release ${tag} has no ${assetName}. The installed binary was not changed.`);

    const binary = join(downloadDir, assetName);
    const size = statSync(binary).size;
    dlSpinner.stop(`Downloaded ${assetName} (${(size / 1024 / 1024).toFixed(0)} MB)`);

    // Verify against the release's .sha256 before anything replaces the
    // installed binary, fetched the same way as the binary, into its own
    // directory so it never collides with the binary already downloaded.
    const checksumName = `${assetName}.sha256`;
    const checksumDir = join(downloadDir, "checksum");
    mkdirSync(checksumDir);
    let sum: "ok" | "missing" | { refused: number } = "missing";
    try {
      sum = await fetchAsset(checksumName, tag, checksumDir, via);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      exitFailed();
    }
    if (typeof sum === "object") {
      p.log.error(
        `github.com answered HTTP ${sum.refused} for ${checksumName}, so the download cannot be verified. The installed binary was not changed.`,
      );
      exitFailed();
    }
    if (sum === "missing") {
      p.log.warn(`Release ${tag} has no ${checksumName}; installing without verifying the download.`);
    } else {
      const expected = parseChecksumFile(readFileSync(join(checksumDir, checksumName), "utf-8"));
      if (expected === null) {
        p.log.error(`${checksumName} in ${tag} holds no SHA-256 digest. The installed binary was not changed.`);
        exitFailed();
      }
      const actual = sha256File(binary);
      if (actual !== expected) {
        p.log.error(
          `Checksum mismatch for ${assetName}: ${checksumName} says ${expected}, the download is ${actual}. ` +
            "The download is corrupt or was tampered with; the installed binary was not changed.",
        );
        exitFailed();
      }
      p.log.success("Checksum verified");
    }

    // Find where swarm is installed (must be on PATH)
    try {
      installPath = runFile("sh", ["-c", "command -v swarm"]);
    } catch {
      p.log.error("Cannot find existing swarm binary on PATH.");
      p.log.info("Reinstall via: curl -fsSL https://mnmal-ai.github.io/swarm/install.sh | bash");
      exitFailed();
    }

    const installSpinner = p.spinner();
    installSpinner.start("Installing...");

    // Stop the spinner before any sudo prompt — clack spinners and
    // password prompts conflict on the same line.
    installSpinner.stop("Installing...");

    let installedWithSudo = false;
    try {
      // Try without sudo first, fall back to sudo (inherit stdio so
      // sudo can prompt via TTY and keep the password cache for
      // subsequent privileged steps like codesign).
      try {
        copyFileSync(binary, installPath);
        chmodSync(installPath, 0o755);
      } catch {
        installedWithSudo = true;
        if (!runInherit("sudo", ["cp", binary, installPath])) {
          throw new Error("sudo cp failed");
        }
        if (!runInherit("sudo", ["chmod", "+x", installPath])) {
          throw new Error("sudo chmod failed");
        }
      }

      // On macOS, AMFI (kernel-level code-signing enforcement) refuses
      // to load any executable without a valid signature. On Apple
      // Silicon this is strict; on recent x86_64 macOS it is also
      // enforced. The bun-compiled release artifact either ships
      // unsigned or has its signature invalidated by the install-time
      // write, so we apply an ad-hoc signature in place. `--force`
      // replaces any existing (now-stale) signature; `--sign -`
      // requests an ad-hoc identity that needs no certificate.
      //
      // This is distinct from Gatekeeper's `com.apple.quarantine`
      // xattr, which is a separate user-space defense. Removing
      // quarantine does not satisfy AMFI; only a valid signature does.
      if (os === "darwin") {
        const signCmd = installedWithSudo
          ? { cmd: "sudo", args: ["codesign", "--force", "--sign", "-", installPath] }
          : { cmd: "codesign", args: ["--force", "--sign", "-", installPath] };
        if (!runInherit(signCmd.cmd, signCmd.args)) {
          throw new Error(
            "ad-hoc codesign failed; the binary will be SIGKILLed by AMFI on launch",
          );
        }
      }
    } catch (err) {
      p.log.error(`Could not install to ${installPath}: ${err instanceof Error ? err.message : String(err)}`);
      if (os === "darwin") {
        p.log.info(
          `On Apple Silicon, every binary must carry a code signature or AMFI will kill it.\n` +
            `Try manually: ${installedWithSudo ? "sudo " : ""}codesign --force --sign - ${installPath}`,
        );
      }
      exitFailed();
    }

    p.log.success("Installed");
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }

  reportResult(installPath);
}

function reportResult(installPath: string): void {
  const cmd = installPath;

  let newVersion: string;
  try {
    newVersion = runFile(cmd, ["--version"]);
  } catch (err) {
    const failure = classifyLaunchError(err);
    if (failure.kind === "sigkill") {
      p.log.error("Installed binary was killed by the kernel (SIGKILL).");
      p.log.info(
        "This usually means the code signature is missing or invalid.\n" +
          "On Apple Silicon, AMFI requires every binary to be signed; this is a\n" +
          "kernel-level check, not Gatekeeper. Clearing the quarantine xattr will\n" +
          "not help here — only signing the binary will.\n" +
          `Try: sudo codesign --force --sign - ${installPath}`,
      );
      p.outro(pc.red("Failed."));
      process.exit(1);
    }
    p.log.error(`Installed binary did not launch: ${failure.raw}`);
    p.log.info(
      "On macOS, this can indicate a missing or invalid code signature.\n" +
        `Try: sudo codesign --force --sign - ${installPath}`,
    );
    p.outro(pc.red("Failed."));
    process.exit(1);
  }

  const oldTag = `v${VERSION}`;
  if (newVersion.includes(VERSION)) {
    p.log.success(`${pc.bold(newVersion)} (already up to date)`);
  } else {
    p.log.success(`Upgraded: ${pc.dim(oldTag)} -> ${pc.bold(newVersion)}`);
  }

  p.outro(pc.green("Done."));
}

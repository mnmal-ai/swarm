import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Script-level tests for scripts/install.sh.
//
// The installer runs for real against stubs on PATH: `uname` reports
// linux/aarch64 (so the asset is swarm-linux-arm64 and no macOS xattr step
// runs), `gh` serves release assets from a directory the way the real one does
// (it refuses to overwrite a file without --clobber), `curl` does the same for
// github.com URLs, and `sudo` refuses. Nothing leaves the machine and nothing
// is written outside the temp directory.
// ---------------------------------------------------------------------------

const SCRIPT = resolve(__dirname, "..", "..", "..", "scripts", "install.sh");
const TAG = "v1.0.0-alpha.7";
const ASSET = "swarm-linux-arm64";
const BINARY = "#!/bin/sh\necho 'swarm 1.0.0-alpha.7'\n";

let dir: string;
let bin: string;
let serve: string;
let installDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swarm-install-script-"));
  bin = join(dir, "bin");
  serve = join(dir, "serve");
  installDir = join(dir, "install");
  mkdirSync(bin);
  mkdirSync(join(serve, TAG), { recursive: true });
  stub(
    "uname",
    `case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; *) echo Linux ;; esac\n`,
  );
  stub("sudo", `echo "sudo $*" >> "${join(dir, "sudo.log")}"\nexit 1\n`);
  stub(
    "curl",
    // A curl for the release URLs: FAKE_CURL=public serves $FAKE_SERVE
    // (releases.json for the API, <tag>/<asset> for downloads, 404 otherwise);
    // anything else answers every URL the way github.com answers an
    // unauthenticated caller for a private repository (FAKE_CURL_CODE, default 404).
    `out=""; fmt=""; url=""; file=""; hdr=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) fmt="$2"; shift ;;
    -D) hdr="$2"; shift ;;
    -H) case "$2" in Authorization:*) echo "curl auth $2" >> "${join(dir, "curl.log")}" ;; esac; shift ;;
    --proto|--retry|--connect-timeout|--max-time) shift ;;
    http*) url="$1" ;;
  esac
  shift
done
echo "curl $url" >> "${join(dir, "curl.log")}"
code="\${FAKE_CURL_CODE:-404}"
if [ "$FAKE_CURL" = public ]; then
  code=404
  case "$url" in
    https://api.github.com/repos/mnmal-ai/swarm/releases*) file="$FAKE_SERVE/releases.json" ;;
    https://github.com/mnmal-ai/swarm/releases/download/*) file="$FAKE_SERVE/\${url#https://github.com/mnmal-ai/swarm/releases/download/}" ;;
  esac
  [ -n "$file" ] && [ -f "$file" ] && code=200
fi
if [ "$code" = 200 ]; then
  if [ -n "$out" ]; then cp "$file" "$out"; else cat "$file"; fi
elif [ -n "$out" ]; then
  printf 'Not Found' > "$out"
fi
# Response headers (-D): FAKE_CURL_HEADERS, with \n between lines.
[ -n "$hdr" ] && printf "HTTP/2 %s\r\n%b\r\n" "$code" "\${FAKE_CURL_HEADERS:-}" > "$hdr"
[ -n "$fmt" ] && printf '%s' "$code"
exit 0
`,
  );
  stub(
    "gh",
    // A gh that serves $FAKE_SERVE/<tag>/<asset>. FAKE_GH=none hides it,
    // FAKE_GH=unauthed fails `auth status`, FAKE_GH_FAIL=<asset> fails that download.
    `echo "gh $*" >> "${join(dir, "gh.log")}"
case "$1 $2" in
  "--version "*) echo "gh version 2.100.0 (fake)"; exit 0 ;;
  "auth status") [ "$FAKE_GH" = unauthed ] && exit 1; exit 0 ;;
  "repo view") exit 0 ;;
  "release list")
    # With FAKE_GH_LIST_JSON, answer like gh: run the caller's --jq expression
    # over that list (through jq), so the installer's draft filter is exercised.
    if [ -n "$FAKE_GH_LIST_JSON" ]; then
      expr=""
      while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && expr="$2"; shift; done
      printf '%s' "$FAKE_GH_LIST_JSON" | jq -r "$expr"
      exit $?
    fi
    echo "${TAG}"; exit 0 ;;
  "release view") [ -d "$FAKE_SERVE/$3" ] || exit 1; ls "$FAKE_SERVE/$3"; exit 0 ;;
  "release download")
    shift 2; tag=""; dest="."; clobber=false; patterns=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --repo) shift ;;
        --tag) tag="$2"; shift ;;
        -p) patterns="$patterns $2"; shift ;;
        -D) dest="$2"; shift ;;
        --clobber) clobber=true ;;
      esac
      shift
    done
    for p in $patterns; do
      [ "$p" = "$FAKE_GH_FAIL" ] && { echo "HTTP 500" >&2; exit 1; }
      [ -f "$FAKE_SERVE/$tag/$p" ] || { echo "no assets match the file pattern" >&2; exit 1; }
      if [ -e "$dest/$p" ] && [ "$clobber" = false ]; then echo "$dest/$p already exists" >&2; exit 1; fi
    done
    for p in $patterns; do cp "$FAKE_SERVE/$tag/$p" "$dest/$p"; done
    exit 0 ;;
esac
echo "fake gh: unexpected $*" >&2
exit 1
`,
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
  chmodSync(join(bin, name), 0o755);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Publish the binary (and, unless `checksum` is null, its .sha256) in the fake release. */
function publish(checksum: string | null = sha256(BINARY)): void {
  writeFileSync(join(serve, TAG, ASSET), BINARY);
  if (checksum !== null) writeFileSync(join(serve, TAG, `${ASSET}.sha256`), `${checksum}  ${ASSET}\n`);
}

function install(env: Record<string, string> = {}, args: string[] = []) {
  if (env.FAKE_GH === "none") rmSync(join(bin, "gh"), { force: true });
  return spawnSync("bash", [SCRIPT, "--install-dir", installDir, ...args], {
    encoding: "utf-8",
    env: {
      // The stubs first; no /usr/local/bin or package-manager dirs, so neither
      // a real gh nor an installed swarm is visible.
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: dir,
      TMPDIR: dir,
      NO_COLOR: "1",
      FAKE_SERVE: serve,
      ...env,
    },
  });
}

const installed = () => join(installDir, "swarm");

describe("scripts/install.sh — checksum verification (gh download)", () => {
  it("verifies the binary against the release's .sha256 and installs it", () => {
    publish();
    const r = install();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Checksum verified");
    expect(readFileSync(installed(), "utf-8")).toBe(BINARY);
  });

  it("refuses a binary that does not match its .sha256, naming both digests, and installs nothing", () => {
    const wrong = "0".repeat(64);
    publish(wrong);
    const r = install();
    expect(r.status).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/checksum/i);
    expect(out).toContain(wrong);
    expect(out).toContain(sha256(BINARY));
    expect(existsSync(installed())).toBe(false);
  });

  it("installs with a single warning when the release carries no .sha256 (an older release)", () => {
    publish(null);
    const r = install();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain("Checksum verified");
    expect((r.stdout.match(/no swarm-linux-arm64\.sha256/g) ?? []).length).toBe(1);
    expect(readFileSync(installed(), "utf-8")).toBe(BINARY);
  });

  it("stops when the .sha256 exists but cannot be downloaded", () => {
    publish();
    const r = install({ FAKE_GH_FAIL: `${ASSET}.sha256` });
    expect(r.status).not.toBe(0);
    expect(existsSync(installed())).toBe(false);
  });

  it("never runs anything through sudo when the install directory is writable", () => {
    publish();
    install();
    expect(existsSync(join(dir, "sudo.log"))).toBe(false);
  });
});

describe("scripts/install.sh — unauthenticated download from github.com", () => {
  const API = "https://api.github.com/repos/mnmal-ai/swarm/releases";
  const DOWNLOAD = `https://github.com/mnmal-ai/swarm/releases/download/${TAG}/${ASSET}`;
  const log = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf-8") : "");

  /** The releases API answer: newest first, pretty-printed the way GitHub sends it. */
  function publishList(tags: string[] = [TAG]): void {
    const list = tags.map((t) => ({ url: `${API}/1`, tag_name: t, draft: false, prerelease: true, assets: [] }));
    writeFileSync(join(serve, "releases.json"), JSON.stringify(list, null, 2));
  }

  it("installs a public release with curl alone (no gh on PATH), verified against its .sha256", () => {
    publish();
    publishList([TAG, "v1.0.0-alpha.6"]);
    const r = install({ FAKE_CURL: "public", FAKE_GH: "none" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Version: ${TAG} (latest)`);
    expect(r.stdout).toContain("Checksum verified");
    expect(readFileSync(installed(), "utf-8")).toBe(BINARY);
    expect(log("curl.log")).toContain(API);
    expect(log("curl.log")).toContain(DOWNLOAD);
    expect(log("curl.log")).toContain(`${DOWNLOAD}.sha256`);
  });

  it("does not use gh, even when it is logged in, while github.com serves the release", () => {
    publish();
    publishList();
    const r = install({ FAKE_CURL: "public" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log("gh.log")).not.toMatch(/release (list|view|download)/);
  });

  it("downloads a --version tag directly, without asking the releases API", () => {
    publish();
    const r = install({ FAKE_CURL: "public", FAKE_GH: "none" }, ["--version", TAG]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log("curl.log")).not.toContain(API);
    expect(log("curl.log")).toContain(DOWNLOAD);
  });

  it("refuses a public download that does not match its .sha256", () => {
    publish("1".repeat(64));
    publishList();
    const r = install({ FAKE_CURL: "public", FAKE_GH: "none" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("1".repeat(64));
    expect(existsSync(installed())).toBe(false);
  });

  it("installs a public release without a .sha256 with a single warning", () => {
    publish(null);
    publishList();
    const r = install({ FAKE_CURL: "public", FAKE_GH: "none" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect((r.stdout.match(/no swarm-linux-arm64\.sha256/g) ?? []).length).toBe(1);
  });

  it("stops when there is no published release", () => {
    publishList([]);
    const r = install({ FAKE_CURL: "public", FAKE_GH: "none" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/No swarm releases found/);
  });

  it.each(["404", "403"])("falls back to a logged-in gh when github.com answers %s", (code) => {
    publish();
    const r = install({ FAKE_CURL_CODE: code });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Checksum verified");
    expect(log("gh.log")).toMatch(/release download .*-p swarm-linux-arm64 /);
    expect(readFileSync(installed(), "utf-8")).toBe(BINARY);
  });

  it("without gh, a 404 stops with what to do and never calls the repository private", () => {
    publish();
    const r = install({ FAKE_GH: "none" });
    expect(r.status).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("HTTP 404");
    expect(out).toContain("gh auth login");
    expect(out).not.toMatch(/This is a private repository|download from private repo/);
    expect(existsSync(installed())).toBe(false);
  });

  it("does not fall back to a gh that is not logged in", () => {
    publish();
    const r = install({ FAKE_GH: "unauthed" });
    expect(r.status).not.toBe(0);
    expect(log("gh.log")).not.toMatch(/release (list|view|download)/);
  });

  const hasJq = spawnSync("sh", ["-c", "command -v jq"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } }).status === 0;
  const ghList = (...list: Array<[string, boolean]>) =>
    JSON.stringify(list.map(([tagName, isDraft]) => ({ tagName, isDraft })));

  it.skipIf(!hasJq)("on the gh fallback, picks the newest release that is not a draft (the installer's jq filter)", () => {
    publish();
    const r = install({ FAKE_GH_LIST_JSON: ghList(["v1.0.0-alpha.8", true], [TAG, false], ["v1.0.0-alpha.6", false]) });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Version: ${TAG} (latest)`);
    expect(log("gh.log")).toMatch(/release list .*--json tagName,isDraft/);
  });

  it.skipIf(!hasJq)("on the gh fallback, finds no release when every one is a draft", () => {
    publish();
    const r = install({ FAKE_GH_LIST_JSON: ghList(["v1.0.0-alpha.8", true]) });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/No swarm releases found/);
    expect(existsSync(installed())).toBe(false);
  });

  it("says a rate-limited API (403, no requests left) is the rate limit, with the wait, and leaves gh alone", () => {
    publish();
    const reset = Math.floor(Date.now() / 1000) + 600;
    const r = install({ FAKE_CURL_CODE: "403", FAKE_CURL_HEADERS: `x-ratelimit-remaining: 0\nx-ratelimit-reset: ${reset}` });
    expect(r.status).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/GitHub API rate limit reached: retry in (9|10) minutes, or set GH_TOKEN/);
    expect(out).not.toMatch(/install gh|gh auth login/);
    expect(log("gh.log")).not.toMatch(/release (list|view|download)/);
  });

  it("treats a 429 as the rate limit too", () => {
    publish();
    const r = install({ FAKE_CURL_CODE: "429", FAKE_CURL_HEADERS: "retry-after: 120" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/rate limit reached: retry in 2 minutes/);
  });

  it("sends GH_TOKEN to the releases API only, when it is set", () => {
    publish();
    publishList();
    const r = install({ FAKE_CURL: "public", FAKE_GH: "none", GH_TOKEN: "test-token" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(log("curl.log").match(/curl auth Authorization: Bearer test-token/g) ?? []).toHaveLength(1);
  });

  it("does not fall back to gh on a server error, only on 404/403", () => {
    publish();
    const r = install({ FAKE_CURL_CODE: "500" });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("HTTP 500");
    expect(log("gh.log")).not.toMatch(/release (list|view|download)/);
  });
});

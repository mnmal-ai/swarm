import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  globalUninstallNotes,
  installDirs,
  installedBinary,
  refuseRemoval,
  removeInstalledBinary,
  stripCopilotSwarmSection,
  isSafeRelativePath,
} from "../src/cli/uninstall.js";
import { VERSION_PATTERN } from "../src/cli/upgrade.js";

describe("stripCopilotSwarmSection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-uninstall-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when file has no swarm markers", () => {
    const file = join(dir, "copilot-instructions.md");
    writeFileSync(file, "# Copilot Instructions\n\nSome custom content.\n");

    const result = stripCopilotSwarmSection(file);

    expect(result).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe("# Copilot Instructions\n\nSome custom content.\n");
  });

  it("strips swarm section and preserves surrounding content", () => {
    const file = join(dir, "copilot-instructions.md");
    const content = [
      "# Copilot Instructions",
      "",
      "Custom content before.",
      "",
      "<!-- swarm:begin — Managed by swarm. -->",
      "",
      "Swarm-managed content here.",
      "",
      "<!-- swarm:end -->",
      "",
      "Custom content after.",
      "",
    ].join("\n");
    writeFileSync(file, content);

    const result = stripCopilotSwarmSection(file);

    expect(result).toBe(true);
    const updated = readFileSync(file, "utf-8");
    expect(updated).toContain("Custom content before.");
    expect(updated).toContain("Custom content after.");
    expect(updated).not.toContain("swarm:begin");
    expect(updated).not.toContain("Swarm-managed content");
  });

  it("deletes file when swarm section is the only content", () => {
    const file = join(dir, "copilot-instructions.md");
    const content = [
      "<!-- swarm:begin — Managed by swarm. -->",
      "",
      "Swarm-managed content here.",
      "",
      "<!-- swarm:end -->",
    ].join("\n");
    writeFileSync(file, content);

    const result = stripCopilotSwarmSection(file);

    expect(result).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("returns false when end marker appears before begin marker", () => {
    const file = join(dir, "copilot-instructions.md");
    const content = [
      "<!-- swarm:end -->",
      "Some content",
      "<!-- swarm:begin -->",
    ].join("\n");
    writeFileSync(file, content);

    const result = stripCopilotSwarmSection(file);

    expect(result).toBe(false);
    // File should be unchanged
    expect(readFileSync(file, "utf-8")).toBe(content);
  });

  it("returns false when only begin marker exists", () => {
    const file = join(dir, "copilot-instructions.md");
    const content = "Some content\n<!-- swarm:begin -->\nOrphaned section\n";
    writeFileSync(file, content);

    const result = stripCopilotSwarmSection(file);

    expect(result).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe(content);
  });

  it("returns false when only end marker exists", () => {
    const file = join(dir, "copilot-instructions.md");
    const content = "Some content\n<!-- swarm:end -->\nOrphaned section\n";
    writeFileSync(file, content);

    const result = stripCopilotSwarmSection(file);

    expect(result).toBe(false);
    expect(readFileSync(file, "utf-8")).toBe(content);
  });
});

describe("isSafeRelativePath", () => {
  const cwd = "/home/user/project";

  it("accepts normal relative paths", () => {
    expect(isSafeRelativePath(".claude/commands/prepare-for-swarm.md", cwd)).toBe(true);
    expect(isSafeRelativePath(".cursor/rules/prepare-for-swarm.mdc", cwd)).toBe(true);
    expect(isSafeRelativePath("SWARM-PROMPT.md", cwd)).toBe(true);
  });

  it("rejects paths with .. traversal", () => {
    expect(isSafeRelativePath("../outside-file.md", cwd)).toBe(false);
    expect(isSafeRelativePath("foo/../../etc/passwd", cwd)).toBe(false);
    expect(isSafeRelativePath(".swarm/../../../etc/hosts", cwd)).toBe(false);
  });

  it("rejects absolute paths that escape cwd", () => {
    expect(isSafeRelativePath("/etc/passwd", cwd)).toBe(false);
    expect(isSafeRelativePath("/tmp/malicious", cwd)).toBe(false);
  });
});

describe("VERSION_PATTERN", () => {
  it("accepts valid semver versions", () => {
    expect(VERSION_PATTERN.test("1.2.3")).toBe(true);
    expect(VERSION_PATTERN.test("v1.2.3")).toBe(true);
    expect(VERSION_PATTERN.test("v0.17.0")).toBe(true);
    expect(VERSION_PATTERN.test("v1.2.3-beta.1")).toBe(true);
    expect(VERSION_PATTERN.test("v1.2.3-rc.2")).toBe(true);
    expect(VERSION_PATTERN.test("10.20.30")).toBe(true);
  });

  it("rejects invalid versions", () => {
    expect(VERSION_PATTERN.test("latest")).toBe(false);
    expect(VERSION_PATTERN.test("v1")).toBe(false);
    expect(VERSION_PATTERN.test("v1.2")).toBe(false);
    expect(VERSION_PATTERN.test("../evil")).toBe(false);
    expect(VERSION_PATTERN.test("v1.2.3; rm -rf ~")).toBe(false);
    expect(VERSION_PATTERN.test("v1.2.3 --repo evil/repo")).toBe(false);
    expect(VERSION_PATTERN.test("")).toBe(false);
  });
});

describe("globalUninstallNotes", () => {
  it("stops the Substrate sidecars first, and says what stays behind", () => {
    const notes = globalUninstallNotes("/home/u");
    expect(notes.before.join("\n")).toMatch(/Stop every Substrate sidecar.*\/home\/u\/\.swarm\/substrate\/stacks/);
    const after = notes.after.join("\n");
    expect(after).toContain("/home/u/.swarm/substrate");
    expect(after).toContain("/home/u/.swarm/infrastructure");
    expect(after).toMatch(/Docker volumes/);
  });
});

describe("uninstall --global: the installed binary", () => {
  let dir: string;
  let home: string;
  let custom: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swarm-uninstall-global-"));
    home = join(dir, "home");
    custom = join(dir, "custom-bin");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(custom);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const place = (where: string, name = "swarm") => {
    const path = join(where, name);
    writeFileSync(path, "#!/bin/sh\n");
    return path;
  };

  it("knows the installer's directories: /usr/local/bin, ~/.local/bin and $SWARM_INSTALL_DIR", () => {
    expect(installDirs(home, {})).toEqual(["/usr/local/bin", join(home, ".local", "bin")]);
    expect(installDirs(home, { SWARM_INSTALL_DIR: custom })).toEqual([
      "/usr/local/bin",
      join(home, ".local", "bin"),
      custom,
    ]);
  });

  it("is this process's own executable when it runs as the compiled binary", () => {
    const binary = place(custom);
    expect(
      installedBinary({ execPath: binary, entry: "/$bunfs/root/swarm", isBun: true, onPath: () => "/elsewhere/swarm" }),
    ).toBe(binary);
  });

  it("is the swarm on PATH when this process is node or tsx running the sources", () => {
    expect(
      installedBinary({ execPath: "/opt/node/bin/node", entry: "/src/cli/main.ts", isBun: false, onPath: () => "/usr/local/bin/swarm" }),
    ).toBe("/usr/local/bin/swarm");
    expect(installedBinary({ execPath: "/opt/node/bin/node", entry: "x.js", isBun: false, onPath: () => null })).toBeNull();
  });

  it("removes a binary in an install directory and says where it was", () => {
    const binary = place(join(home, ".local", "bin"));
    const dirs = installDirs(home, {});
    expect(refuseRemoval(binary, dirs)).toBeNull();
    expect(removeInstalledBinary(binary)).toBe(binary);
    expect(existsSync(binary)).toBe(false);

    const inCustom = place(custom);
    expect(refuseRemoval(inCustom, installDirs(home, { SWARM_INSTALL_DIR: custom }))).toBeNull();
  });

  it("refuses a binary outside the install directories, and leaves it", () => {
    const binary = place(custom);
    const reason = refuseRemoval(binary, installDirs(home, {}));
    expect(reason).toContain(binary);
    expect(reason).toContain("/usr/local/bin");
    expect(existsSync(binary)).toBe(true);
  });

  it("refuses anything not named swarm, even in an install directory", () => {
    const node = place(join(home, ".local", "bin"), "node");
    expect(refuseRemoval(node, installDirs(home, {}))).toMatch(/not a swarm binary/);
  });

  it("judges a path with `..` by where it resolves, not by how it is spelled", () => {
    mkdirSync(join(custom, "nested"));
    mkdirSync(join(dir, "outside"));
    place(custom);
    place(join(dir, "outside"));
    const dirs = installDirs(home, { SWARM_INSTALL_DIR: custom });
    expect(refuseRemoval(`${custom}/nested/../swarm`, dirs)).toBeNull();
    expect(refuseRemoval(`${custom}/../outside/swarm`, dirs)).not.toBeNull();
    expect(existsSync(join(dir, "outside", "swarm"))).toBe(true);
  });

  it("judges a symlinked parent directory by its target", () => {
    mkdirSync(join(dir, "elsewhere"));
    place(join(dir, "elsewhere"));
    place(custom);
    const dirs = installDirs(home, { SWARM_INSTALL_DIR: custom });
    // A link inside an install directory that leads out of it is refused.
    symlinkSync(join(dir, "elsewhere"), join(custom, "link"));
    expect(refuseRemoval(join(custom, "link", "swarm"), dirs)).not.toBeNull();
    // A link from outside that leads into an install directory names the binary there.
    symlinkSync(custom, join(dir, "alias"));
    expect(refuseRemoval(join(dir, "alias", "swarm"), dirs)).toBeNull();
    // An install directory given through a link matches the real directory.
    expect(refuseRemoval(join(custom, "swarm"), installDirs(home, { SWARM_INSTALL_DIR: join(dir, "alias") }))).toBeNull();
  });

  it("refuses a path in a subdirectory of an install directory", () => {
    mkdirSync(join(custom, "nested"));
    const binary = place(join(custom, "nested"));
    expect(refuseRemoval(binary, installDirs(home, { SWARM_INSTALL_DIR: custom }))).not.toBeNull();
  });
});

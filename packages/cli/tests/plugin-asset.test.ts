import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachePluginTarball, resolvePluginTarball } from "../src/substrate/plugin-asset.js";

function tarEntry(tgz: string, entry: string): string {
  return execFileSync("tar", ["-xOf", tgz, entry], { encoding: "utf8" });
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("plugin-asset", () => {
  it("the packed tarball carries a substrate manifest and the pinned version", async () => {
    const { path, version } = await resolvePluginTarball();
    const manifest = JSON.parse(tarEntry(path, "package/package.json"));
    expect(manifest.substrate.tier).toBe("coordinator");
    expect(manifest.version).toBe(version);
  });

  it("caches the embedded tarball in a 0700 directory as a 0600 file, tightening what was there", async () => {
    const { path: source, version } = await resolvePluginTarball();
    const bytes = readFileSync(source);
    const root = mkdtempSync(join(tmpdir(), "plugin-cache-"));
    try {
      const fresh = join(root, "fresh", "cache");
      const cached = await cachePluginTarball(bytes, fresh);
      expect(cached).toEqual({ path: join(fresh, `swarm-substrate-plugin-${version}.tgz`), version });
      expect(mode(fresh)).toBe(0o700);
      expect(mode(cached.path)).toBe(0o600);
      expect(readdirSync(fresh)).toEqual([`swarm-substrate-plugin-${version}.tgz`]); // no staging file left

      // An existing, too-open cache from an earlier version of swarm.
      const loose = join(root, "loose");
      mkdirSync(loose, { mode: 0o755 });
      chmodSync(loose, 0o755);
      const existing = join(loose, `swarm-substrate-plugin-${version}.tgz`);
      writeFileSync(existing, bytes);
      chmodSync(existing, 0o644);
      await cachePluginTarball(bytes, loose);
      expect(mode(loose)).toBe(0o700);
      expect(mode(existing)).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

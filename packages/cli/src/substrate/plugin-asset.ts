import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PluginTarball {
  path: string;
  version: string;
}

const TARBALL_NAME = "swarm-substrate-plugin.tgz";

function isBun(): boolean {
  return Boolean(process.versions.bun) || typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/** Walk up from this module to find packages/cli/assets (src/ or dist/src/). */
function devTarballPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "assets", TARBALL_NAME);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    `${TARBALL_NAME} not found; run 'bash scripts/pack-substrate-plugin.sh' (or pnpm build in packages/cli).`,
  );
}

function readVersion(tgz: string): string {
  const raw = execFileSync("tar", ["-xOf", tgz, "package/package.json"], { encoding: "utf8" });
  return (JSON.parse(raw) as { version: string }).version;
}

/** ~/.swarm/substrate/cache, where a Bun binary's embedded tarball is copied. */
function defaultCacheDir(): string {
  return join(homedir(), ".swarm", "substrate", "cache");
}

/**
 * Write `bytes` (a packed plugin tarball) to `cacheDir` as
 * `swarm-substrate-plugin-<version>.tgz` and return it. The directory is 0700
 * and the file 0600 — also when an earlier swarm left them more open — and the
 * file is rewritten only when its size differs.
 */
export async function cachePluginTarball(bytes: Buffer, cacheDir: string = defaultCacheDir()): Promise<PluginTarball> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700);

  // Version lives inside the tarball; stage it once to read the manifest.
  const staged = join(cacheDir, `.staging-${process.pid}.tgz`);
  await writeFile(staged, bytes, { mode: 0o600 });
  let version: string;
  try {
    version = readVersion(staged);
  } finally {
    await rm(staged, { force: true });
  }

  const path = join(cacheDir, `swarm-substrate-plugin-${version}.tgz`);
  const existing = await stat(path).catch(() => undefined);
  if (!existing || existing.size !== bytes.length) {
    await writeFile(path, bytes, { mode: 0o600 });
  }
  await chmod(path, 0o600);
  return { path, version };
}

/**
 * Locate the plugin tarball. In a Bun single-file binary the embedded file
 * lives in $bunfs, which npm cannot read, so it is copied to a real cache path.
 */
export async function resolvePluginTarball(): Promise<PluginTarball> {
  if (!isBun()) {
    const path = devTarballPath();
    return { path, version: readVersion(path) };
  }

  const mod = await import("./plugin-asset-bun.js");
  const embedded = mod.default;
  return cachePluginTarball(Buffer.from(await readFile(embedded)));
}

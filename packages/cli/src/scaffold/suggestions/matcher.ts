// Suggestion engine for the /prepare-for-swarm flow.
//
// This module is the runtime counterpart to the pure-data catalog: it loads the
// catalog (loadCatalog), inspects a target repo (detectEnvironment), and decides
// which catalog entries are relevant given that inspection (matchSuggestions).
// Only matchSuggestions is pure; loadCatalog and detectEnvironment touch fs.

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScanResult } from '@mnmal-ai/swarm-types';
import { Scanner } from '../../scanner/index.js';
import {
  SUGGESTION_AXES,
  type CatalogEntry,
  type DetectionSignal,
  type SuggestionAxis,
} from './types.js';

// The matcher reads catalog.json from its own directory rather than a fixed path
// so the same code works in both runtime contexts: under src/ during Vitest (where
// matcher.ts sits beside catalog.json) and under dist/ at runtime, where the build's
// `cp -r src/scaffold/suggestions dist/scaffold/` step places catalog.json beside the
// compiled matcher.js. Resolving via import.meta.url keeps that invariant regardless
// of the process CWD.
const CATALOG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'catalog.json');

/**
 * On-disk shape of catalog.json: a `$comment` banner plus the entries array.
 * Only `entries` is load-bearing; `$comment` is documentation that ships with
 * the data file.
 */
interface CatalogFile {
  $comment?: string;
  entries: CatalogEntry[];
}

/**
 * Read and parse the suggestion catalog that ships beside this module.
 *
 * Synchronous on purpose: the catalog is small, ships in-SDK, and every caller
 * (detection, the prompt loop, the shape test) wants it eagerly before doing any
 * work — async here would only add ceremony.
 *
 * @returns the catalog entries, typed as {@link CatalogEntry}[].
 * @throws if catalog.json is missing or unreadable beside the module — a clear,
 *   actionable error rather than a raw ENOENT, since a missing catalog means the
 *   build's copy step did not run.
 */
export function loadCatalog(): CatalogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(CATALOG_PATH, 'utf-8');
  } catch (cause) {
    throw new Error(
      `Suggestion catalog not found at ${CATALOG_PATH}. ` +
        'It must ship beside the matcher module (the build copies ' +
        'src/scaffold/suggestions into dist). This indicates a broken build or packaging step.',
      { cause },
    );
  }

  // Shape guard against a present-but-malformed catalog. JSON.parse will
  // accept any valid JSON (`null`, `[]`, `{}`, …); we need a real
  // `{ entries: [] }` envelope. Without the guard a malformed file
  // surfaces as a `TypeError: Cannot read properties of undefined` deep
  // in the matcher, far from the actual cause. Throw a specific message
  // at the read site so the failure points at the catalog file.
  const parsed = JSON.parse(raw) as Partial<CatalogFile>;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(
      `Suggestion catalog at ${CATALOG_PATH} is malformed — expected an object with an 'entries' array.`,
    );
  }
  return parsed.entries;
}

/**
 * What `detectEnvironment` learned about the target repo. Fed to the matcher so
 * the suggestion loop can pre-answer "is this entry relevant?" instead of asking
 * the user about tooling already present.
 *
 * `available` is the load-bearing field: `false` means detection could not read
 * the filesystem at all (no fs access in the agent backend, or a bad path), and
 * the calling skill must fall back to a verbal interview. When `false`, every
 * other field is its empty/degraded value rather than a throw — degrade, never
 * crash, so a missing capability downgrades the flow instead of aborting it.
 */
export interface DetectionReport {
  /** True when the filesystem was readable and the base scan ran. */
  available: boolean;

  /**
   * The base detected-stacks report from the {@link Scanner}, or `null` when
   * detection degraded (no fs access). Carries the broad signal (languages,
   * frameworks, package managers, tests, CI) the Scanner already knows how to find.
   */
  scan: ScanResult | null;

  /**
   * Merged dependency names from package.json (`dependencies` +
   * `devDependencies`). Read directly here — independent of the Scanner — so the
   * matcher can evaluate arbitrary `dependency` detection signals against a flat
   * set without re-parsing package.json. Empty when there is no package.json or
   * detection degraded.
   */
  dependencies: string[];

  /**
   * Explicit per-tool detections this task is required to recognize. Each is a
   * convenience flag layered on top of {@link scan}/{@link dependencies}:
   * - `vercel`: vercel.json or a .vercel/ directory is present, OR a `vercel`
   *   dependency exists. Vercel is a deploy platform, not a framework, so it is
   *   detected here via file-presence + dependency rather than the Scanner's
   *   framework map.
   * - `hono`: a `hono` dependency exists (also surfaced as a "Hono" framework by
   *   the Scanner, which this task extended its NPM_FRAMEWORK_MAP to recognize).
   * - `drizzle`: a `drizzle-orm` dependency exists (also surfaced as "Drizzle").
   */
  detected: {
    vercel: boolean;
    hono: boolean;
    drizzle: boolean;
  };
}

/** The empty/degraded report returned when the filesystem is unreadable. */
function degradedReport(): DetectionReport {
  return {
    available: false,
    scan: null,
    dependencies: [],
    detected: { vercel: false, hono: false, drizzle: false },
  };
}

/** True if `target` exists (file or directory). Any error reads as "absent". */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merged dependency names from package.json. A missing or malformed package.json
 * is a normal outcome (not every repo is Node), so it reads as no dependencies
 * rather than an error. Callers gate fs-availability separately via the probe in
 * {@link detectEnvironment}.
 */
async function readDependencyNames(projectPath: string): Promise<string[]> {
  try {
    const raw = await readFile(join(projectPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  } catch {
    return [];
  }
}

/**
 * Inspect a target repo and report the environment signals the suggestion flow
 * needs. Reuses the {@link Scanner} for the broad detected-stacks report, then
 * augments it with direct package.json dependency reads and file-presence checks
 * for the specific tools the menu cares about (Vercel, Hono, Drizzle).
 *
 * Async because the Scanner and every fs read are async; the documented return
 * shape is {@link DetectionReport} (resolved value), not a separate type.
 *
 * Never throws. If the filesystem is unreadable — no fs access in the agent
 * backend, or a path that does not exist — it returns a degraded report
 * (`available: false`) so the calling skill can fall back to a verbal interview
 * rather than crash the onboarding flow. A readable-but-empty repo is NOT
 * degraded: it returns `available: true` with empty findings.
 */
export async function detectEnvironment(projectPath: string): Promise<DetectionReport> {
  // Probe fs reachability once against the project root. This is what separates
  // "filesystem unavailable / bad path" (degrade to interview) from "readable but
  // empty repo" (a valid, available report with no findings). Without the probe,
  // the Scanner's internal error-swallowing would make the two indistinguishable.
  if (!(await pathExists(projectPath))) {
    return degradedReport();
  }

  try {
    const scan = await new Scanner(projectPath).scan();
    const dependencies = await readDependencyNames(projectPath);
    const deps = new Set(dependencies);

    const hasVercelFile =
      (await pathExists(join(projectPath, 'vercel.json'))) ||
      (await pathExists(join(projectPath, '.vercel')));

    return {
      available: true,
      scan,
      dependencies,
      detected: {
        vercel: hasVercelFile || deps.has('vercel'),
        hono: deps.has('hono'),
        drizzle: deps.has('drizzle-orm'),
      },
    };
  } catch {
    // Belt-and-suspenders: the probe passed but something downstream still threw
    // (e.g. fs access revoked mid-scan). Degrade rather than propagate.
    return degradedReport();
  }
}

// ---------------------------------------------------------------------------
// matchSuggestions — pure relevance matching
// ---------------------------------------------------------------------------

/**
 * Per-axis cap: the maximum number of entries any one axis may offer. A
 * suggestion-fatigue guard — beyond a handful of yes/customize/no prompts per
 * axis the menu stops being a menu and starts being a chore. Five is the ceiling
 * the plan sets (4-5); ordering is deterministic so the cap drops a stable tail.
 */
const MAX_PER_AXIS = 5;

/**
 * Impact ordering for the per-axis cap. Lower rank sorts first, so higher-impact
 * entries survive the cap. Entries without an `impact` rank last among matches.
 */
const IMPACT_RANK: Record<NonNullable<CatalogEntry['impact']>, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** A fresh `Record<SuggestionAxis, CatalogEntry[]>` with every axis present and empty. */
function emptyGroups(): Record<SuggestionAxis, CatalogEntry[]> {
  const groups = {} as Record<SuggestionAxis, CatalogEntry[]>;
  for (const axis of SUGGESTION_AXES) groups[axis] = [];
  return groups;
}

/**
 * Total order over catalog entries, used to make the per-axis cap deterministic
 * regardless of catalog array order or which entries happened to match. Sorts by
 * impact (high → medium → low → unranked), then by `id` as a stable alphabetical
 * tiebreak.
 */
function compareEntries(a: CatalogEntry, b: CatalogEntry): number {
  const rankA = a.impact ? IMPACT_RANK[a.impact] : 3;
  const rankB = b.impact ? IMPACT_RANK[b.impact] : 3;
  if (rankA !== rankB) return rankA - rankB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Compile a detection glob to an anchored RegExp, or `null` if the glob is
 * malformed. A pure matcher must never throw on bad catalog data, so callers
 * treat `null` as "matches nothing".
 *
 * Supported glob syntax (the only forms the catalog uses):
 * - literal segments and `.` (e.g. `vercel.json`, `Package.swift`)
 * - `*` — any run of non-`/` characters within a single path segment
 * - `**` / `**​/` — any number of path segments (e.g. `k8s/**​/*.yaml`)
 * - a trailing `/**` also matches the directory itself, so `api/**` matches both
 *   the bare `api` directory entry and anything beneath it. This matters because
 *   the {@link Scanner} reports top-level directories as bare paths.
 */
function globToRegExp(glob: string): RegExp | null {
  // A trailing `/**` should match the directory entry itself, not only its
  // contents. Strip it here and re-attach an optional subtree at the end.
  let body = glob;
  let matchesSubtree = false;
  if (body.endsWith('/**')) {
    body = body.slice(0, -3);
    matchesSubtree = true;
  }

  let out = '^';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*') {
      if (body[i + 1] === '*') {
        i++;
        if (body[i + 1] === '/') {
          i++;
          out += '(?:[^/]*/)*'; // `**​/` — zero or more whole path segments
        } else {
          out += '.*'; // bare `**` — anything, crossing segment boundaries
        }
      } else {
        out += '[^/]*'; // `*` — within a single segment
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c; // literal, including `/`
    }
  }
  if (matchesSubtree) out += '(?:/.*)?';
  out += '$';

  try {
    return new RegExp(out);
  } catch {
    return null;
  }
}

/**
 * True if any dependency name matches the signal's regex `pattern`. A malformed
 * pattern is treated as a non-match (never a throw) so one bad catalog entry
 * cannot abort matching for the rest.
 */
function matchesDependencyPattern(pattern: string, dependencies: string[]): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return false;
  }
  return dependencies.some((dep) => re.test(dep));
}

/**
 * The set of repo paths the matcher can test `file` globs against. The
 * {@link Scanner} only reports a top-level structural overview (plus entry points
 * and root docs), so this is deliberately best-effort: deeply-nested file signals
 * may not resolve, but the catalog backs those with dependency signals that do.
 *
 * One bridge: `detectEnvironment` reliably knows Vercel even when the shallow
 * scan drops a hidden `.vercel/` directory, so seed `.vercel` when that flag is
 * set to keep the `.vercel/**` glob honest. Hono and Drizzle need no bridge —
 * they are dependency-detected, which {@link matchesDependencyPattern} covers.
 */
function collectKnownPaths(report: DetectionReport): string[] {
  const { scan } = report;
  if (!scan) return [];
  const paths = [
    ...scan.project_structure.map((entry) => entry.path),
    ...scan.entry_points,
    ...scan.existing_docs,
  ];
  if (report.detected.vercel) paths.push('.vercel');
  return paths;
}

/** Evaluate a single detection signal against the report. */
function signalMatches(
  signal: DetectionSignal,
  report: DetectionReport,
  knownPaths: string[],
): boolean {
  switch (signal.kind) {
    case 'dependency':
      return matchesDependencyPattern(signal.pattern, report.dependencies);
    case 'file': {
      const re = globToRegExp(signal.glob);
      return re !== null && knownPaths.some((p) => re.test(p));
    }
    case 'env':
      // The DetectionReport models repo files + dependencies, not the process
      // environment, so env signals cannot be confirmed here. Entries gated only
      // by env (e.g. a bot token) degrade to the verbal interview the calling
      // skill runs for unconfirmed offers, rather than being silently dropped.
      return false;
  }
}

/**
 * True if the entry should be offered. An empty `detection` array means "always
 * offer" (per {@link CatalogEntry.detection}); otherwise any matching signal is
 * enough (signals are OR'd).
 */
function entryMatches(entry: CatalogEntry, report: DetectionReport, knownPaths: string[]): boolean {
  if (entry.detection.length === 0) return true;
  return entry.detection.some((signal) => signalMatches(signal, report, knownPaths));
}

/**
 * Decide which catalog entries are relevant to the inspected repo and group the
 * matches by their {@link SuggestionAxis}.
 *
 * Pure: depends only on its arguments — no LLM, no fs, no env reads — so it is
 * fully deterministic and trivially testable. The returned record always has an
 * entry for every axis (empty when nothing matched), and each axis is sorted by
 * {@link compareEntries} then capped at {@link MAX_PER_AXIS} as a fatigue guard.
 *
 * A degraded report (`available: false`, i.e. the backend could not read the
 * filesystem) matches nothing: the caller falls back to a verbal interview, so
 * auto-offering against empty findings would be misleading.
 *
 * @param report  what {@link detectEnvironment} learned about the target repo.
 * @param catalog the entries from {@link loadCatalog}.
 * @returns matched entries grouped per axis, deterministically ordered and capped.
 */
export function matchSuggestions(
  report: DetectionReport,
  catalog: CatalogEntry[],
): Record<SuggestionAxis, CatalogEntry[]> {
  const grouped = emptyGroups();
  if (!report.available) return grouped;

  const knownPaths = collectKnownPaths(report);
  for (const entry of catalog) {
    // Guard against a malformed axis in catalog data: a pure function must not
    // throw on a bad entry, so skip anything that is not one of the known axes.
    if (!grouped[entry.axis]) continue;
    if (entryMatches(entry, report, knownPaths)) {
      grouped[entry.axis].push(entry);
    }
  }

  for (const axis of SUGGESTION_AXES) {
    grouped[axis] = grouped[axis].sort(compareEntries).slice(0, MAX_PER_AXIS);
  }
  return grouped;
}

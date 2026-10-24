import { describe, it, expect } from 'vitest';
import type { ScanResult } from '@mnmal-ai/swarm-types';
import { type DetectionReport, loadCatalog, matchSuggestions } from './matcher.js';
import { SUGGESTION_AXES, type CatalogEntry } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal ScanResult with everything empty; override per test. */
function emptyScan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    project_name: 'fixture',
    languages: [],
    package_managers: [],
    frameworks: [],
    project_structure: [],
    has_tests: false,
    test_frameworks: [],
    has_ci: false,
    ci_platforms: [],
    existing_docs: [],
    entry_points: [],
    ...overrides,
  };
}

/** An available report with empty findings; override per test. */
function report(overrides: Partial<DetectionReport> = {}): DetectionReport {
  return {
    available: true,
    scan: emptyScan(),
    dependencies: [],
    detected: { vercel: false, hono: false, drizzle: false },
    ...overrides,
  };
}

function entry(over: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'axis'>): CatalogEntry {
  return {
    title: over.id,
    suggestionText: 'text',
    detection: [],
    templateFiles: [],
    ...over,
  };
}

function ids(entries: CatalogEntry[]): string[] {
  return entries.map((e) => e.id);
}

describe('matchSuggestions', () => {
  it('returns an empty group for every axis when nothing matches', () => {
    const result = matchSuggestions(report(), []);
    for (const axis of SUGGESTION_AXES) {
      expect(result[axis]).toEqual([]);
    }
  });

  it('returns all-empty groups (matching nothing) when detection degraded', () => {
    // available:false means the backend could not read fs — the caller falls
    // back to a verbal interview, so a definitely-matching entry is NOT offered.
    const degraded: DetectionReport = {
      available: false,
      scan: null,
      dependencies: [],
      detected: { vercel: false, hono: false, drizzle: false },
    };
    const alwaysOffer = entry({ id: 'always', axis: 'skill', detection: [] });
    const result = matchSuggestions(degraded, [alwaysOffer]);
    expect(result.skill).toEqual([]);
  });

  it('offers an entry with an empty detection array unconditionally', () => {
    const alwaysOffer = entry({ id: 'always', axis: 'mcp', detection: [] });
    const result = matchSuggestions(report(), [alwaysOffer]);
    expect(ids(result.mcp)).toEqual(['always']);
  });

  it('groups a matched entry under its own axis', () => {
    const dep = entry({
      id: 'drizzle-doctor',
      axis: 'skill',
      detection: [{ kind: 'dependency', pattern: '^drizzle-orm$' }],
    });
    const result = matchSuggestions(report({ dependencies: ['drizzle-orm'] }), [dep]);
    expect(ids(result.skill)).toEqual(['drizzle-doctor']);
    expect(result.mcp).toEqual([]);
    expect(result['deployment-completion']).toEqual([]);
  });

  it('matches dependency signals as regexes, not literals', () => {
    const scoped = entry({
      id: 'sentry-mcp',
      axis: 'mcp',
      detection: [{ kind: 'dependency', pattern: '@sentry/' }],
    });
    expect(ids(matchSuggestions(report({ dependencies: ['@sentry/node'] }), [scoped]).mcp)).toEqual(
      ['sentry-mcp'],
    );
    // Anchored pattern must not match a longer name.
    const anchored = entry({
      id: 'pg',
      axis: 'mcp',
      detection: [{ kind: 'dependency', pattern: '^pg$' }],
    });
    expect(matchSuggestions(report({ dependencies: ['pg-pool'] }), [anchored]).mcp).toEqual([]);
  });

  it('treats OR semantics across multiple signals', () => {
    const multi = entry({
      id: 'multi',
      axis: 'skill',
      detection: [
        { kind: 'dependency', pattern: '^vitest$' },
        { kind: 'dependency', pattern: '^jest$' },
      ],
    });
    expect(ids(matchSuggestions(report({ dependencies: ['jest'] }), [multi]).skill)).toEqual([
      'multi',
    ]);
  });

  it('matches a top-level file glob against the scan structure', () => {
    const fly = entry({
      id: 'fly-deploy',
      axis: 'deployment-completion',
      detection: [{ kind: 'file', glob: 'fly.toml' }],
    });
    const r = report({
      scan: emptyScan({ project_structure: [{ path: 'fly.toml', type: 'file' }] }),
    });
    expect(ids(matchSuggestions(r, [fly])['deployment-completion'])).toEqual(['fly-deploy']);
  });

  it('matches a `dir/**` glob against both the bare directory and its subtree', () => {
    const github = entry({
      id: 'github-mcp',
      axis: 'mcp',
      detection: [{ kind: 'file', glob: '.github/**' }],
    });
    // Scanner reports `.github` as a bare top-level directory entry.
    const bare = report({
      scan: emptyScan({ project_structure: [{ path: '.github', type: 'directory' }] }),
    });
    expect(ids(matchSuggestions(bare, [github]).mcp)).toEqual(['github-mcp']);
  });

  it('bridges detected.vercel so the `.vercel/**` glob matches a hidden dir', () => {
    const vercelMcp = entry({
      id: 'vercel-mcp',
      axis: 'mcp',
      detection: [{ kind: 'file', glob: '.vercel/**' }],
    });
    // Scan structure is empty (hidden .vercel is dropped) but the flag is set.
    const r = report({ detected: { vercel: true, hono: false, drizzle: false } });
    expect(ids(matchSuggestions(r, [vercelMcp]).mcp)).toEqual(['vercel-mcp']);
  });

  it('never matches env signals (not modeled in the report) and does not throw', () => {
    const slack = entry({
      id: 'slack-mcp',
      axis: 'mcp',
      detection: [{ kind: 'env', name: 'SLACK_BOT_TOKEN' }],
    });
    expect(matchSuggestions(report(), [slack]).mcp).toEqual([]);
  });

  it('does not throw on a malformed dependency regex; treats it as no match', () => {
    const bad = entry({
      id: 'bad',
      axis: 'skill',
      detection: [{ kind: 'dependency', pattern: '(' }],
    });
    expect(() => matchSuggestions(report({ dependencies: ['anything'] }), [bad])).not.toThrow();
    expect(matchSuggestions(report({ dependencies: ['anything'] }), [bad]).skill).toEqual([]);
  });

  it('caps each axis at five entries, dropping the lowest-ranked tail', () => {
    // Seven always-offer skill entries with mixed impact; only the top five
    // (by impact then id) survive.
    const mk = (id: string, impact?: CatalogEntry['impact']) =>
      entry({ id, axis: 'skill', detection: [], impact });
    const catalog = [
      mk('low-z', 'low'),
      mk('high-b', 'high'),
      mk('med-a', 'medium'),
      mk('high-a', 'high'),
      mk('low-a', 'low'),
      mk('unranked', undefined),
      mk('med-b', 'medium'),
    ];
    const result = matchSuggestions(report(), catalog);
    expect(result.skill).toHaveLength(5);
    // high (a,b) → medium (a,b) → low-a, dropping low-z and unranked.
    expect(ids(result.skill)).toEqual(['high-a', 'high-b', 'med-a', 'med-b', 'low-a']);
  });

  it('orders matches deterministically regardless of input array order', () => {
    const mk = (id: string, impact: CatalogEntry['impact']) =>
      entry({ id, axis: 'mcp', detection: [], impact });
    const forward = matchSuggestions(report(), [mk('a', 'low'), mk('b', 'high')]).mcp;
    const reversed = matchSuggestions(report(), [mk('b', 'high'), mk('a', 'low')]).mcp;
    expect(ids(forward)).toEqual(['b', 'a']);
    expect(ids(reversed)).toEqual(ids(forward));
  });

  it('every shipped catalog entry has at least one evaluable detection signal', () => {
    // Regression guard for the "env-only entry" class of bug (caught in a
    // review of `slack-mcp`): an entry with only `env` signals is
    // permanently unreachable through `matchSuggestions` — `signalMatches`
    // returns `false` for env (env state isn't modeled in DetectionReport).
    // The original `detection.length > 0` shape check passed vacuously on
    // such entries. This one demands at least one non-`env` signal per
    // entry, which is exactly what `matchSuggestions` is willing to evaluate.
    // An empty `detection` array is still allowed (unconditional offer per
    // the documented contract).
    const catalog = loadCatalog();
    for (const e of catalog) {
      if (e.detection.length === 0) continue; // unconditional offer
      const evaluable = e.detection.filter((s) => s.kind !== 'env');
      expect(
        evaluable.length,
        `catalog entry '${e.id}' has only env-kind signals — it would be unreachable via matchSuggestions`,
      ).toBeGreaterThan(0);
    }
  });

  it('matches real catalog entries against a representative Drizzle+Vercel repo', () => {
    const catalog = loadCatalog();
    const r = report({
      dependencies: ['drizzle-orm', 'vercel', 'zod'],
      detected: { vercel: true, hono: false, drizzle: true },
      scan: emptyScan({ project_structure: [{ path: 'vercel.json', type: 'file' }] }),
    });
    const result = matchSuggestions(r, catalog);

    expect(ids(result.skill)).toContain('drizzle-schema-doctor');
    expect(ids(result.skill)).toContain('zod-validation-audit');
    expect(ids(result['deployment-completion'])).toContain('vercel-deploy');
    expect(ids(result.mcp)).toContain('vercel-mcp');

    // Fatigue guard holds against the shipped catalog.
    for (const axis of SUGGESTION_AXES) {
      expect(result[axis].length).toBeLessThanOrEqual(5);
    }
  });
});

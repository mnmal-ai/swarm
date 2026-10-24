/**
 * Presence-triggered ship-readiness gate — runner.
 *
 * Given a loaded contract (presence already confirmed by the caller — Decision P),
 * this shells out to `contract.promoteCommand`, then polls each smoke endpoint.
 * The two failure modes are kept distinct in the result so a reviewer can act on
 * each differently and a smoke-test failure can never mask a real deploy bug:
 *
 *   - deploy exits non-zero  -> outcome "deploy-failed" (exit code + stderr). The
 *     endpoints are NOT polled: a failed deploy leaves the targets reflecting the
 *     old release (or nothing), so polling would mislabel a deploy bug as an env
 *     failure.
 *   - deploy succeeds but any endpoint fails its status/JSON assertion ->
 *     outcome "smoke-failed" with every failing endpoint surfaced.
 *   - deploy succeeds and every endpoint passes -> outcome "passed".
 *
 * Both side effects are injected (see RunShipReadinessGateOpts) so the module is
 * fully unit-testable with no real process or network — mirroring the injection
 * patterns in functional-validator.ts and rate-limit-gate.ts. The default
 * implementations below are provider-agnostic: the command runner wraps
 * node:child_process and the fetch wraps the global, with no Vercel/CDK
 * assumptions baked in.
 */

import { spawn } from "node:child_process";

import type {
  CommandRunner,
  FailedEndpoint,
  Fetch,
  FetchResponse,
  RunShipReadinessGateOpts,
  ShipReadinessGateResult,
  SmokeEndpoint,
} from "./types.js";

/** Status assumed for a smoke endpoint when the contract omits `expectStatus`. */
const DEFAULT_EXPECTED_STATUS = 200;

/**
 * Default deploy-command runner. Provider-agnostic: it shells out to the raw
 * command string from the contract via `shell: true`, so callers never have to
 * pre-parse argv and no provider CLI is assumed. Resolves with the captured
 * result even on a non-zero exit; rejects only when the shell itself cannot be
 * launched (the documented CommandRunner contract).
 */
export const defaultCommandRunner: CommandRunner = (command, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, { cwd: opts?.cwd, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // 'error' fires only when the process could not be spawned at all (e.g. the
    // shell binary is missing). A command that runs and fails surfaces via a
    // non-zero exit code on 'close', not here.
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });

/** Default smoke-endpoint timeout — kills a stalled poll before it hangs the gate. */
const SMOKE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Default smoke-endpoint fetch — the WHATWG global, hardened with a 30 s
 * AbortController timeout. Without the timeout, an endpoint that accepts the
 * TCP connection but never sends a response would hang `runShipReadinessGate`
 * indefinitely and block goal completion for the entire run. Node's `fetch`
 * has no built-in request deadline, so we layer one here. The signal-driven
 * abort surfaces as a rejected `fetch()` promise, which `checkEndpoint`
 * already classifies as a network error — same blast radius as connection
 * refused, no separate branch needed.
 */
export const defaultFetch: Fetch = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMOKE_FETCH_TIMEOUT_MS);
  try {
    return await globalThis.fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Run the presence-triggered ship-readiness gate for one goal.
 *
 * The caller is responsible for the presence check and goal scoping
 * (`loadShipReadinessContract` / `gateAppliesToGoal`); this function assumes the
 * gate applies and just executes deploy + smoke.
 */
export async function runShipReadinessGate(
  opts: RunShipReadinessGateOpts,
): Promise<ShipReadinessGateResult> {
  const { contract, cwd } = opts;
  const runCommand = opts.runCommand ?? defaultCommandRunner;
  const fetchFn = opts.fetch ?? defaultFetch;

  // Step 1: deploy. The command is provider-agnostic — whatever string the
  // contract carries.
  const deploy = await runCommand(contract.promoteCommand, { cwd });
  if (deploy.exitCode !== 0) {
    return {
      outcome: "deploy-failed",
      deployExitCode: deploy.exitCode,
      deployStderr: deploy.stderr,
    };
  }

  // Step 2: smoke. Poll every endpoint and collect all failures, so the reviewer
  // sees the full blast radius rather than only the first miss. A contract with
  // no smokeEndpoints passes the gate on deploy success alone.
  const failedEndpoints: FailedEndpoint[] = [];
  for (const endpoint of contract.smokeEndpoints ?? []) {
    const failure = await checkEndpoint(endpoint, fetchFn);
    if (failure) failedEndpoints.push(failure);
  }

  if (failedEndpoints.length > 0) {
    return { outcome: "smoke-failed", failedEndpoints };
  }

  return { outcome: "passed" };
}

/**
 * Poll a single endpoint and return a FailedEndpoint describing the failure, or
 * null when it passes. Failure causes are kept distinct in `reason` so triage
 * can tell a network error from a status mismatch from a JSON-assertion miss.
 */
async function checkEndpoint(
  endpoint: SmokeEndpoint,
  fetchFn: Fetch,
): Promise<FailedEndpoint | null> {
  const expectedStatus = endpoint.expectStatus ?? DEFAULT_EXPECTED_STATUS;

  let response: FetchResponse;
  try {
    response = await fetchFn(endpoint.url);
  } catch (err) {
    // The request itself failed (DNS, connection refused, TLS). No HTTP
    // response arrived, so actualStatus is null.
    return {
      url: endpoint.url,
      expectedStatus,
      actualStatus: null,
      reason: `request failed: ${errorMessage(err)}`,
    };
  }

  if (response.status !== expectedStatus) {
    return {
      url: endpoint.url,
      expectedStatus,
      actualStatus: response.status,
      reason: `expected status ${expectedStatus}, got ${response.status}`,
    };
  }

  // Optional JSON assertion: the value at `jsonPath` must deep-equal
  // `expectEquals`. Only runs when the contract sets `jsonPath`.
  if (endpoint.jsonPath !== undefined) {
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return {
        url: endpoint.url,
        expectedStatus,
        actualStatus: response.status,
        reason: `expected JSON body but parsing failed: ${errorMessage(err)}`,
      };
    }

    const actual = readJsonPath(body, endpoint.jsonPath);
    if (!deepEqual(actual, endpoint.expectEquals)) {
      return {
        url: endpoint.url,
        expectedStatus,
        actualStatus: response.status,
        reason: `JSON assertion failed at ${endpoint.jsonPath}: expected ${stringify(
          endpoint.expectEquals,
        )}, got ${stringify(actual)}`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Minimal JSONPath + deep-equality helpers
//
// Kept dependency-free (no new top-level dep): the smoke assertion only needs to
// pluck one value out of a response body and compare it. Fancier JSONPath
// (filters, wildcards, recursive descent) is intentionally out of scope.
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted/bracketed path against a parsed JSON value. Supports a
 * leading `$`, dot keys (`$.a.b`), and bracket access with numeric indices or
 * quoted keys (`$.a[0]["b"]`). Returns undefined if any segment is missing.
 */
function readJsonPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const token of tokenizeJsonPath(path)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function tokenizeJsonPath(path: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  if (path[i] === "$") i++;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i++;
      continue;
    }
    if (ch === "[") {
      i++;
      let inner = "";
      while (i < path.length && path[i] !== "]") inner += path[i++];
      i++; // skip closing ]
      inner = inner.trim();
      if (
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"))
      ) {
        inner = inner.slice(1, -1);
      }
      tokens.push(inner);
      continue;
    }
    // Bare key segment up to the next separator.
    let key = "";
    while (i < path.length && path[i] !== "." && path[i] !== "[") key += path[i++];
    if (key) tokens.push(key);
  }
  return tokens;
}

/** Structural deep equality for JSON-shaped values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray || bIsArray) {
    if (!aIsArray || !bIsArray || a.length !== b.length) return false;
    return a.every((v, idx) => deepEqual(v, b[idx]));
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
  );
}

function stringify(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

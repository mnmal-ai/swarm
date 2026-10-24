/**
 * swarm doctor — print one consolidated status table for the whole Substrate stack.
 *
 * This is the operator's "what's actually running?" view: the Node the sidecars
 * run on, the Substrate runtime, lsof (macOS), cold Postgres, cold sidecar, meta
 * Postgres, meta sidecar, dashboard, and the swarm CLI version — all in a single
 * aligned table, each unhealthy row carrying the concrete command that fixes it.
 *
 * Diagnose-only: this command NEVER calls `ensureSubstrateReady` (or any ensure-/
 * start- machinery) and brings nothing online as a side effect. Its job is to
 * report on a possibly-sick stack, so it must run cleanly with zero sidecars up.
 * All probing is delegated to the fail-soft `collectDoctorRows()` in
 * ./doctor-probes — every row is a state, never a thrown error — and we simply
 * render what it returns.
 *
 * Rendering follows the existing inline-ANSI style in packages/cli (see
 * substrate.ts): no table-rendering dependency, columns aligned by hand against
 * the visible (ANSI-stripped) width of each cell.
 */

import { VERSION, COMMIT_HASH } from "../version.js";
import { type DoctorDeps, type DoctorRow, type DoctorState, collectDoctorRows } from "./doctor-probes.js";

// --- ANSI helpers (mirror substrate.ts) ---

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/**
 * Map a probe state to its display word + color. Consistent with the codebase's
 * existing usage: green = healthy, red = down, amber/yellow = a soft problem the
 * operator should look at (a healthy-but-wrong sidecar, or an indeterminate probe).
 */
function stateLabel(state: DoctorState): { word: string; color: string } {
  switch (state) {
    case "ok":
      return { word: "ok", color: GREEN };
    case "down":
      return { word: "down", color: RED };
    case "wrong-namespace":
      return { word: "wrong-ns", color: YELLOW };
    case "unknown":
      return { word: "unknown", color: YELLOW };
  }
}

/** Visible width of a string with ANSI escapes stripped — used for manual alignment. */
function visibleWidth(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes.
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Right-pad `s` to `width` based on its visible (ANSI-stripped) length. */
function padVisible(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

/**
 * Render the consolidated table. The swarm-CLI-version row is appended here (always
 * `ok`, just reporting the build) rather than coming from the probes — it isn't a
 * piece of running infra to dial, it's a fact about this binary.
 */
function renderTable(rows: DoctorRow[]): string {
  const versionRow: DoctorRow = {
    component: "swarm CLI",
    state: "ok",
    detail: `${VERSION} (${COMMIT_HASH})`,
  };
  const allRows = [...rows, versionRow];

  // Column widths from the longest visible cell, so cold/meta labels of differing
  // length still line up. State column is sized off the widest state word.
  const componentWidth = Math.max(...allRows.map((r) => r.component.length));
  const stateWidth = Math.max(...allRows.map((r) => stateLabel(r.state).word.length));

  const lines: string[] = [];
  lines.push("");
  lines.push(`${BOLD}Swarm Doctor${RESET}`);
  lines.push("");

  for (const row of allRows) {
    const { word, color } = stateLabel(row.state);
    const component = padVisible(`${BOLD}${row.component}${RESET}`, componentWidth);
    const state = padVisible(`${color}${word}${RESET}`, stateWidth);
    lines.push(`  ${component}  ${state}  ${DIM}${row.detail}${RESET}`);
    if (row.fixCommand) {
      // Align the fix hint under the detail column so the suggested command reads as
      // a continuation of the unhealthy row.
      const indent = " ".repeat(2 + componentWidth + 2 + stateWidth + 2);
      lines.push(`${indent}${CYAN}fix:${RESET} ${row.fixCommand}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// --- Public entry point ---

/**
 * `swarm doctor` — collect a fail-soft diagnostic row for every piece of infra and
 * print the consolidated table. Accepts the parsed-flags bag for signature parity
 * with the other CLI commands; doctor takes no options today. Never starts
 * anything. `deps` replaces the machine probes (tests).
 */
export async function runDoctor(_args: Record<string, string> = {}, deps: Partial<DoctorDeps> = {}): Promise<void> {
  const rows = await collectDoctorRows(deps);
  console.log(renderTable(rows));
}

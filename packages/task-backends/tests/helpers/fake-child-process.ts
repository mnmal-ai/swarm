import { promisify } from "node:util";
import { vi, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// A stand-in for `node:child_process` in which no process ever starts.
//
//   vi.mock("node:child_process", async () =>
//     (await import("./helpers/fake-child-process.js")).fakeChildProcessModule());
//
// `execFile` is a mock with Node's calling convention — (file, args, options,
// callback), returning a child — and, like the real one, a promisify.custom
// that resolves `{ stdout, stderr }`, rejects with an error carrying both, and
// exposes the child as `.child`. The module under test promisifies it exactly
// as it would promisify the real execFile.
//
// What the CLI does is `cli`: a function of (file, args, options) that returns
// what the CLI prints on stdout, or throws to fail (a thrown error's `stderr`
// is what it printed there). Configure it the way the old synchronous mocks
// were configured. The callback fires on a later turn of the event loop, as a
// real child's exit does.
// ---------------------------------------------------------------------------

export type ExecFileCallback = (error: unknown, stdout: string, stderr: string) => void;

/** The part of a ChildProcess the code under test touches. */
export interface FakeChild {
  stdin: { on: Mock; end: Mock };
}

export type CliBehaviour = (file: string, args: string[], options: Record<string, unknown>) => string;

/** What the CLI does when it runs. Reset it in beforeEach. */
export const cli = vi.fn<CliBehaviour>(() => "");

export function fakeChild(): FakeChild {
  return { stdin: { on: vi.fn(), end: vi.fn() } };
}

function runFakeCli(
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: ExecFileCallback,
): FakeChild {
  let stdout = "";
  let error: unknown = null;
  try {
    stdout = cli(file, args, options);
  } catch (err) {
    error = err;
  }
  const stderr = (error as { stderr?: string } | null)?.stderr ?? "";
  setImmediate(() => callback(error, error ? "" : stdout, stderr));
  return fakeChild();
}

export function fakeChildProcessModule() {
  const execFile = vi.fn(runFakeCli);
  Object.defineProperty(execFile, promisify.custom, {
    // Mirrors Node's own promisified execFile.
    value: (file: string, args: string[], options: Record<string, unknown>) => {
      let child: FakeChild | undefined;
      const promise = new Promise((resolve, reject) => {
        child = execFile(file, args, options, (error, stdout, stderr) => {
          if (error) {
            if (typeof error === "object") Object.assign(error, { stdout, stderr });
            reject(error);
          } else {
            resolve({ stdout, stderr });
          }
        });
      });
      return Object.assign(promise, { child });
    },
  });
  return { execFile };
}

/** A call execFile received. */
export interface ExecFileCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
  /** What was written to the child's stdin before it was closed. */
  stdin: string | undefined;
  /** Whether stdin was closed, so the CLI reads EOF instead of waiting. */
  stdinClosed: boolean;
}

/** Every call the mocked execFile has received, in order. */
export function execFileCalls(execFile: Mock): ExecFileCall[] {
  return execFile.mock.calls.map((call, i) => {
    const child = execFile.mock.results[i]?.value as FakeChild | undefined;
    return {
      file: call[0] as string,
      args: call[1] as string[],
      options: (call[2] ?? {}) as Record<string, unknown>,
      stdin: child?.stdin.end.mock.calls[0]?.[0] as string | undefined,
      stdinClosed: (child?.stdin.end.mock.calls.length ?? 0) > 0,
    };
  });
}

/** An Error shaped like the one execFile gives a CLI that exits non-zero. */
export function cliFailure(stderr: string, command = "cli"): Error & { stderr: string } {
  return Object.assign(new Error(`Command failed: ${command}\n${stderr}`), { stderr });
}

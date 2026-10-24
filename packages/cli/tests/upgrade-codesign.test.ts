import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { classifyLaunchError } from "../src/cli/upgrade.js";

// AMFI manifests as SIGKILL. Node surfaces it as either signal: "SIGKILL"
// or status: 137 (128 + 9), depending on whether the child was killed
// post-launch or refused at exec time. Both must classify the same way so
// the user sees the AMFI-specific guidance — not the generic "could not
// verify" warning that historically misdirected users toward the
// Gatekeeper quarantine xattr.
describe("classifyLaunchError", () => {
  it("treats signal=SIGKILL as a sigkill failure", () => {
    const err = { status: null, signal: "SIGKILL" };
    expect(classifyLaunchError(err).kind).toBe("sigkill");
  });

  it("treats status=137 as a sigkill failure", () => {
    const err = { status: 137, signal: null };
    expect(classifyLaunchError(err).kind).toBe("sigkill");
  });

  it("treats status=9 as a sigkill failure", () => {
    const err = { status: 9, signal: null };
    expect(classifyLaunchError(err).kind).toBe("sigkill");
  });

  it("treats a non-SIGKILL exit code as 'other'", () => {
    const err = { status: 1, signal: null };
    expect(classifyLaunchError(err).kind).toBe("other");
  });

  it("treats a plain Error (no exit info) as 'other'", () => {
    const err = new Error("ENOENT: no such file");
    const result = classifyLaunchError(err);
    expect(result.kind).toBe("other");
    expect(result.raw).toBe("ENOENT: no such file");
  });

  it("captures signal and status in the raw detail for sigkill", () => {
    const err = { status: 137, signal: "SIGKILL" };
    const result = classifyLaunchError(err);
    expect(result.kind).toBe("sigkill");
    expect(result.raw).toContain("SIGKILL");
    expect(result.raw).toContain("137");
  });

  // End-to-end check: synthesize a real SIGKILL failure and confirm Node's
  // surfaced error shape matches what the classifier expects. Guards against
  // future Node versions changing the property names.
  it("matches the shape of a real execFileSync SIGKILL failure", () => {
    let caught: unknown;
    try {
      execFileSync("sh", ["-c", "kill -9 $$"], { stdio: "pipe" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(classifyLaunchError(caught).kind).toBe("sigkill");
  });
});

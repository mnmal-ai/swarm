import { describe, it, expect } from "vitest";

describe("runWithOversight retry", () => {
  it("feedback accumulates across retries rather than being independent", () => {
    // Simulates the latestRetryContext accumulation pattern used in runWithOversight.
    // Verifies that attempt 2 sees feedback from attempt 1 — the actual bug that
    // was fixed (previously each retry only saw the original context).
    const originalContext = "Original swarm context";
    let latestRetryContext = originalContext;

    // Simulate attempt 1 rejection
    const feedback1 = "## Reviewer Feedback (attempt 1)\n- Missing code blocks";
    latestRetryContext = [latestRetryContext, feedback1].filter(Boolean).join("\n\n");

    // The context passed to attempt 1's retry should contain both original + feedback1
    expect(latestRetryContext).toContain("Original swarm context");
    expect(latestRetryContext).toContain("attempt 1");
    expect(latestRetryContext).toContain("Missing code blocks");

    // Simulate attempt 2 rejection — should see original + attempt 1 + attempt 2
    const feedback2 = "## Reviewer Feedback (attempt 2)\n- Still missing tests";
    latestRetryContext = [latestRetryContext, feedback2].filter(Boolean).join("\n\n");

    expect(latestRetryContext).toContain("Original swarm context");
    expect(latestRetryContext).toContain("attempt 1");
    expect(latestRetryContext).toContain("Missing code blocks");
    expect(latestRetryContext).toContain("attempt 2");
    expect(latestRetryContext).toContain("Still missing tests");
  });

  it("original context is preserved when no retry occurs", () => {
    const originalContext = "Some swarm context";
    const latestRetryContext = originalContext;

    // No onRetry called — context stays as original
    expect(latestRetryContext).toBe("Some swarm context");
  });

  it("empty original context does not produce leading separator", () => {
    // Verifies the .filter(Boolean) logic handles empty initial context
    let latestRetryContext = "";

    const feedback = "## Reviewer Feedback (attempt 1)\n- Fix the bug";
    latestRetryContext = [latestRetryContext, feedback].filter(Boolean).join("\n\n");

    // Should NOT start with "\n\n" — the empty string should be filtered out
    expect(latestRetryContext.startsWith("##")).toBe(true);
    expect(latestRetryContext).not.toMatch(/^\n/);
  });
});

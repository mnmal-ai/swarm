/**
 * Swarm's own matcher for a role's deniedTools, used by the codex hook. The
 * claude-code backend never uses it: the Agent SDK matches disallowedTools.
 */

import { describe, expect, it } from "vitest";
import { deniesEditing, matchDenied, ruleWords, unenforceableRules } from "../src/deny-matcher.js";

const RULES = ["Bash(git push:*)", "Bash(gh pr merge:*)", "Bash(fly:*)", "Bash(flyctl:*)", "Bash(pnpm ops:*)", "mcp__claude_ai_*"];
const bash = (command: unknown) => matchDenied("Bash", { command }, RULES);

describe("matchDenied", () => {
  it.each([
    "git push origin main",
    "git -C repo push",
    "/usr/bin/git push",
    "GIT_TRACE=1 git push",
    "env FOO=1 git push",
    "env -u HOME git push",
    "sh -c 'git push origin main'",
    `bash -lc "cd x && git push"`,
    `zsh -c "sh -c 'git push'"`,
    "echo $(git push)",
    "echo `git push`",
    "git status && git push",
    "true; git push",
    "git status || git push",
    "cat refs | xargs git push",
    "timeout 30 git push",
    "nohup git push &",
    "eval 'git push'",
    "(cd repo && git push)",
    "gh pr merge 12 --squash",
    "fly deploy",
    "flyctl deploy",
    "pnpm ops deploy",
    "pnpm -C backend ops deploy",
    "npx flyctl deploy",
    "git log --grep push", // over-denies: when unsure, deny
    "echo 'unbalanced",
    // shell keywords before the command
    "if git diff --quiet; then echo ok; else git push; fi",
    "for b in a; do git push origin $b; done",
    "while true; do git push; done",
    "until false; do git push; done",
    "{ git push; }",
    "! git push",
    // redirections without spaces, and before the command
    "git push>/dev/null",
    "git push>&2",
    "git push 2>&1 | tail -5",
    "2>/dev/null git push",
    "</dev/null git push",
    // a line continuation splitting the command
    "git -C repo \\\npush",
    "git \\\n  push",
    // a shell reading its script from a heredoc or here-string
    "sh <<EOF\ngit push\nEOF",
    "bash <<'EOF'\ncd repo\ngit push origin main\nEOF",
    "bash <<< 'git push'",
  ])("denies %s", (command) => {
    expect(bash(command).denied).toBe(true);
  });

  it.each([
    "git status",
    "git log --oneline",
    "pnpm test",
    "echo 'git push is denied'",
    `echo "a && git push"`,
    "grep -r push src",
    "npm run build",
    "node --test",
    "ls -la 2>&1 | tail -5",
    "git status > /tmp/status.txt",
    // a heredoc that is data, not a script, may hold anything
    "git commit -F - <<'EOF'\nDon't push yet: git push comes later\nEOF",
    "cat > notes.md <<EOF\ngit push origin main\nEOF",
    "if git diff --quiet; then echo clean; fi",
  ])("allows %s", (command) => {
    expect(bash(command).denied).toBe(false);
  });

  it("matches an argv array the same as a string", () => {
    expect(bash(["bash", "-lc", "git push"]).denied).toBe(true);
    expect(bash(["git", "status"]).denied).toBe(false);
  });

  it("denies a Bash call whose command it cannot find", () => {
    expect(matchDenied("Bash", {}, RULES).denied).toBe(true);
  });

  it("denies every command for a bare Bash rule, and for Bash(*)", () => {
    expect(matchDenied("Bash", { command: "ls" }, ["Bash"]).denied).toBe(true);
    expect(matchDenied("Bash", { command: "ls" }, ["Bash(*)"]).denied).toBe(true);
  });

  it("matches other rules as globs on the tool name", () => {
    expect(matchDenied("mcp__claude_ai_gmail_send", {}, RULES)).toMatchObject({ denied: true, rule: "mcp__claude_ai_*" });
    expect(matchDenied("apply_patch", { command: "*** Begin Patch" }, RULES).denied).toBe(false);
  });

  it("names the rule, never the command", () => {
    const m = bash("git push origin secret-branch");
    expect(m.rule).toBe("Bash(git push:*)");
    expect(m.reason).not.toContain("secret-branch");
  });

  it("allows everything with no rules", () => {
    expect(matchDenied("Bash", { command: "git push" }, []).denied).toBe(false);
  });

  it("treats * inside a rule's words as a wildcard", () => {
    expect(matchDenied("Bash", { command: "git push origin main" }, ["Bash(git push*)"]).denied).toBe(true);
    expect(matchDenied("Bash", { command: "gh pr merge 3" }, ["Bash(gh pr merge*)"]).denied).toBe(true);
    expect(matchDenied("Bash", { command: "flyctl deploy" }, ["Bash(fly*)"]).denied).toBe(true);
    expect(matchDenied("Bash", { command: "git push --force origin main" }, ["Bash(git * main)"]).denied).toBe(true);
    expect(matchDenied("Bash", { command: "git status" }, ["Bash(git push*)"]).denied).toBe(false);
  });

  it("says which rules a codex session cannot enforce", () => {
    expect(unenforceableRules(["Bash(git push:*)", "Bash", "Edit", "Write", "WebFetch", "mcp__claude_ai_*"])).toEqual([]);
    expect(unenforceableRules(["Read", "Edit(.github/**)", "Read(.env)", "Glob"])).toEqual(["Read", "Edit(.github/**)", "Read(.env)", "Glob"]);
  });

  it("knows when editing is denied", () => {
    expect(deniesEditing(["Edit"])).toBe(true);
    expect(deniesEditing(["Write"])).toBe(true);
    expect(deniesEditing(["Bash(git push:*)"])).toBe(false);
  });

  it("reads a rule's words", () => {
    expect(ruleWords("Bash(git push:*)")).toEqual(["git", "push"]);
    expect(ruleWords("Bash(gh pr merge *)")).toEqual(["gh", "pr", "merge"]);
    expect(ruleWords("Bash(/usr/bin/git push:*)")).toEqual(["git", "push"]);
    expect(ruleWords("Bash(git push*)")).toEqual(["git", "push*"]);
    expect(ruleWords("Bash(git * main)")).toEqual(["git", "main"]);
    expect(ruleWords("Bash")).toBeNull();
    expect(ruleWords("Bash(*)")).toBeNull();
  });
});

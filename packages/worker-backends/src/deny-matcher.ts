/**
 * Swarm's own matcher for a role's `permissions.deniedTools`, for runtimes
 * that leave the matching to swarm (the codex backend's hook). The
 * claude-code backend does not use it: the Agent SDK matches its
 * disallowedTools itself.
 *
 * - `Bash` and `Bash(*)` deny every command.
 * - `Bash(<words>:*)`, `Bash(<words> *)` and `Bash(<words>)` deny a command
 *   when some command inside it is the first word and has the others after
 *   it in order, not necessarily next to each other: `git -C repo push`
 *   matches `Bash(git push:*)`. A `*` inside a word is a wildcard
 *   (`Bash(git push*)`, `Bash(fly*)`). This also matches `git log --grep
 *   push`; when unsure, the matcher denies.
 * - Anything else is a glob on the tool name (`mcp__server__*`).
 *
 * "Some command inside it": the text is split at unquoted `&&`, `||`, `;`,
 * `|`, `&`, newlines and parentheses; `$(…)`, `<(…)` and backtick contents
 * are commands of their own; redirections (`>out`, `2>&1`, `<in`) are
 * dropped; shell keywords (`if`, `then`, `do`, `!`, `{` …) and leading
 * `NAME=value` words and wrappers such as `env`, `nohup`, `timeout 30`,
 * `xargs` or `npx` are dropped; a program is matched by its basename; and
 * `sh`/`bash`/`zsh`/`dash -c '…'`, `eval '…'`, and a heredoc or here-string
 * fed to a shell are checked the same way. A command it cannot read is
 * denied.
 *
 * It reads the shell the way an agent writes it. Deliberate disguise
 * (`g=git; $g push`, `$'git' push`) gets past it; swarm's other layer, no
 * GitHub credentials in the session, still stands behind it.
 */

export interface DenyMatch {
  denied: boolean;
  /** The rule that matched. */
  rule?: string;
  /** Why, for the agent. Never contains command text. */
  reason?: string;
}

const ALLOWED: DenyMatch = { denied: false };
const UNREADABLE = "swarm could not read this command, so it is denied";
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const WRAPPERS = new Set([
  "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "timeout",
  "xargs", "sudo", "doas", "stdbuf", "npx", "bunx", "caffeinate",
]);
/** Shell reserved words that can start a command position. */
const KEYWORDS = new Set(["if", "then", "elif", "else", "fi", "do", "done", "while", "until", "!", "{", "}", "coproc", "esac"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 8;

/** Claude tool names that a codex session's editing tool (apply_patch) stands in for. */
const EDITING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Claude tool names a codex session cannot use at all (its web search is off). */
const ABSENT_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** The words a `Bash(…)` rule names, or null when it denies every command. */
export function ruleWords(rule: string): string[] | null {
  if (rule === "Bash") return null;
  const m = /^Bash\(([\s\S]*)\)$/.exec(rule);
  if (!m) return [];
  let body = m[1].trim();
  if (body === "*" || body === "") return null;
  if (body.endsWith(":*")) body = body.slice(0, -2);
  else if (body.endsWith(" *")) body = body.slice(0, -2);
  const words = body.trim().split(/\s+/).filter((w) => w !== "" && w !== "*");
  if (words.length === 0) return null;
  words[0] = basename(words[0]);
  return words;
}

/** Whether the deny list forbids editing files, by Claude's editing tool names. */
export function deniesEditing(deniedTools: readonly string[]): boolean {
  return deniedTools.some((rule) => EDITING_TOOLS.has(rule));
}

/**
 * Rules a codex session cannot enforce: path-scoped rules on Claude's tools
 * (`Edit(.github/**)`, `Read(.env)`) and bare names of tools codex does not
 * have, such as `Read` (it reads with shell commands). A role with any of
 * these must not run on codex, or the rule would silently do nothing.
 */
export function unenforceableRules(deniedTools: readonly string[]): string[] {
  return deniedTools.filter((rule) => {
    if (rule === "Bash" || /^Bash\([\s\S]*\)$/.test(rule)) return false;
    if (EDITING_TOOLS.has(rule) || ABSENT_TOOLS.has(rule)) return false;
    if (rule.startsWith("mcp__")) return false;
    return true;
  });
}

export function matchDenied(toolName: string, toolInput: unknown, deniedTools: readonly string[]): DenyMatch {
  const bashRules: Array<{ rule: string; words: string[] | null }> = [];
  for (const rule of deniedTools) {
    if (rule === "Bash" || /^Bash\([\s\S]*\)$/.test(rule)) {
      bashRules.push({ rule, words: ruleWords(rule) });
    } else if (globMatch(rule, toolName)) {
      return { denied: true, rule, reason: `denied by ${rule}` };
    }
  }
  if (toolName !== "Bash" || bashRules.length === 0) return ALLOWED;
  const text = commandText(toolInput);
  if (text === null) return { denied: true, reason: UNREADABLE };
  let commands: string[][];
  try {
    commands = simpleCommands(text, 0);
  } catch {
    return { denied: true, reason: UNREADABLE };
  }
  for (const { rule, words } of bashRules) {
    if (words === null || commands.some((c) => matchesWords(c, words))) {
      return { denied: true, rule, reason: `denied by ${rule}` };
    }
  }
  return ALLOWED;
}

function basename(word: string): string {
  return word.replace(/^.*\//, "");
}

function globRegex(pattern: string): RegExp {
  const body = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

function globMatch(pattern: string, name: string): boolean {
  return globRegex(pattern).test(name);
}

function wordMatches(ruleWord: string, word: string): boolean {
  return ruleWord.includes("*") ? globRegex(ruleWord).test(word) : ruleWord === word;
}

/** The command as shell text: a string as is, an argv array quoted word by word. */
function commandText(toolInput: unknown): string | null {
  const command = (toolInput as { command?: unknown } | null | undefined)?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((w) => typeof w === "string")) {
    return command.map((w) => `'${String(w).replace(/'/g, `'\\''`)}'`).join(" ");
  }
  return null;
}

function matchesWords(command: string[], words: string[]): boolean {
  if (!wordMatches(words[0], command[0])) return false;
  let k = 1;
  for (let i = 1; i < command.length && k < words.length; i++) if (wordMatches(words[k], command[i])) k++;
  return k === words.length;
}

/** One simple command's words, and any heredoc or here-string text fed to it. */
interface Segment {
  words: string[];
  bodies: string[];
}

/** Every simple command in `text`, as [program basename, ...arguments]. Throws when unreadable. */
function simpleCommands(text: string, depth: number): string[][] {
  if (depth > MAX_DEPTH) throw new Error("nested too deeply");
  const { segments, nested } = tokenize(text);
  const out: string[][] = [];
  for (const inner of nested) out.push(...simpleCommands(inner, depth + 1));
  for (const segment of segments) {
    const words = unwrap(segment.words);
    if (words.length === 0) continue;
    const program = basename(words[0]);
    if (SHELLS.has(program)) {
      const script = shellScript(words);
      if (script !== null) {
        out.push(...simpleCommands(script, depth + 1));
        continue;
      }
      // A shell reading its script from a heredoc or here-string.
      for (const body of segment.bodies) out.push(...simpleCommands(body, depth + 1));
    }
    if (program === "eval") {
      out.push(...simpleCommands(words.slice(1).join(" "), depth + 1));
      continue;
    }
    out.push([program, ...words.slice(1)]);
  }
  return out;
}

/** Split shell text into simple commands, collecting `$(…)`, `<(…)` and backtick contents. */
function tokenize(text: string): { segments: Segment[]; nested: string[] } {
  const segments: Segment[] = [];
  const nested: string[] = [];
  let segment: Segment = { words: [], bodies: [] };
  let word = "";
  let inWord = false;
  /** What to do with the next word: a redirection's target is dropped, a here-string is kept as a body. */
  let nextWord: "keep" | "drop" | "body" = "keep";
  /** Heredocs opened on the current line, read when it ends. */
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean; segment: Segment }> = [];

  const endWord = () => {
    if (inWord) {
      if (nextWord === "drop") nextWord = "keep";
      else if (nextWord === "body") {
        segment.bodies.push(word);
        nextWord = "keep";
      } else segment.words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    nextWord = "keep";
    if (segment.words.length > 0) segments.push(segment);
    segment = { words: [], bodies: [] };
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endSegment();
      i++;
      // Heredoc bodies start on the line after the one that opened them.
      while (pendingHeredocs.length > 0) {
        const doc = pendingHeredocs.shift()!;
        const body: string[] = [];
        while (i < text.length) {
          const nl = text.indexOf("\n", i);
          const line = text.slice(i, nl === -1 ? text.length : nl);
          i = nl === -1 ? text.length : nl + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
          body.push(line);
        }
        // An unterminated heredoc runs to the end of the text, as the shell reads it.
        doc.segment.bodies.push(body.join("\n"));
      }
    } else if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endSegment();
      i++;
    } else if (c === "#" && !inWord) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
    } else if (c === "\\") {
      // A backslash before a newline continues the line; before anything else it quotes it.
      if (text[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 < text.length) word += text[i + 1];
      inWord = true;
      i += 2;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error("unbalanced single quote");
      word += text.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      const r = readDouble(text, i + 1, nested);
      word += r.value;
      inWord = true;
      i = r.next;
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) throw new Error("unbalanced backtick");
      nested.push(text.slice(i + 1, end));
      inWord = true;
      i = end + 1;
    } else if ((c === "$" || c === "<" || c === ">") && text[i + 1] === "(") {
      const end = matchParen(text, i + 2);
      nested.push(text.slice(i + 2, end));
      inWord = true;
      i = end + 1;
    } else if (c === "<" || c === ">") {
      // A redirection: `2>`'s file descriptor and the operator's target are not command words.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      const start = i;
      while (i < text.length && "<>&|".includes(text[i])) i++;
      const operator = text.slice(start, i);
      if (operator === "<<") {
        let stripTabs = false;
        if (text[i] === "-") {
          stripTabs = true;
          i++;
        }
        while (text[i] === " " || text[i] === "\t") i++;
        const d = readDelimiter(text, i);
        i = d.next;
        pendingHeredocs.push({ delimiter: d.delimiter, stripTabs, segment });
      } else if (operator === "<<<") {
        nextWord = "body";
      } else {
        nextWord = "drop";
      }
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endSegment();
  return { segments, nested };
}

/** A heredoc delimiter, bare or quoted, from position `i`. */
function readDelimiter(text: string, i: number): { delimiter: string; next: number } {
  let delimiter = "";
  while (i < text.length && !" \t\n;&|<>()".includes(text[i])) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end === -1) throw new Error("unbalanced quote in heredoc delimiter");
      delimiter += text.slice(i + 1, end);
      i = end + 1;
    } else if (c === "\\") {
      delimiter += text[i + 1] ?? "";
      i += 2;
    } else {
      delimiter += c;
      i++;
    }
  }
  if (delimiter === "") throw new Error("heredoc without a delimiter");
  return { delimiter, next: i };
}

/** A double-quoted string from just after its opening quote. */
function readDouble(text: string, i: number, nested: string[]): { value: string; next: number } {
  let value = "";
  while (i < text.length) {
    const c = text[i];
    if (c === '"') return { value, next: i + 1 };
    if (c === "\\" && text[i + 1] === "\n") {
      i += 2;
    } else if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
      value += text[i + 1];
      i += 2;
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) throw new Error("unbalanced backtick");
      nested.push(text.slice(i + 1, end));
      i = end + 1;
    } else if (c === "$" && text[i + 1] === "(") {
      const end = matchParen(text, i + 2);
      nested.push(text.slice(i + 2, end));
      i = end + 1;
    } else {
      value += c;
      i++;
    }
  }
  throw new Error("unbalanced double quote");
}

/** Index of the `)` closing a group opened just before `i`. */
function matchParen(text: string, i: number): number {
  let depth = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error("unbalanced single quote");
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i = readDouble(text, i + 1, []).next;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
    i++;
  }
  throw new Error("unbalanced parenthesis");
}

/** Drop leading keywords and assignments, and wrapper programs with their own options. */
function unwrap(segment: string[]): string[] {
  let w = segment;
  for (let guard = 0; guard < 16; guard++) {
    while (w.length > 0 && (ASSIGNMENT.test(w[0]) || KEYWORDS.has(w[0]))) w = w.slice(1);
    if (w.length === 0) return w;
    const program = basename(w[0]);
    if (!WRAPPERS.has(program)) return w;
    w = w.slice(1);
    while (w.length > 0 && (w[0].startsWith("-") || ASSIGNMENT.test(w[0]))) {
      const option = w[0];
      w = w.slice(1);
      const takesValue =
        (program === "env" && ["-u", "-C", "-S"].includes(option)) ||
        (program === "nice" && option === "-n") ||
        (program === "sudo" && ["-u", "-g"].includes(option)) ||
        (program === "timeout" && ["-s", "-k"].includes(option)) ||
        (program === "xargs" && /^-[IndLsP]$/.test(option));
      if (takesValue) w = w.slice(1);
    }
    if (program === "timeout" && w.length > 0 && /^\d/.test(w[0])) w = w.slice(1);
  }
  return w;
}

/** The inline script of `sh -c '…'` (and -lc, -ic, -ec …), or null. */
function shellScript(words: string[]): string | null {
  for (let i = 1; i < words.length; i++) {
    const a = words[i];
    if (a === "--" || !a.startsWith("-")) return null;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
      for (let j = i + 1; j < words.length; j++) if (!words[j].startsWith("-")) return words[j];
      return null;
    }
    if (a === "-o" || a === "+o") i++;
  }
  return null;
}

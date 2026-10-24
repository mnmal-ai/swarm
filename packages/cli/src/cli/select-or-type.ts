/**
 * A hybrid select/text prompt inspired by Claude Code's suggestion UX.
 *
 * Shows a list of suggested answers the user can:
 *   - Arrow through and press Enter to select
 *   - Press Tab on a suggestion to copy it into an editable text field
 *   - Start typing to provide a custom answer (suggestions dim)
 */

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\x1b[2K\r";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export interface SelectOrTypeOptions {
  message: string;
  suggestions: string[];
  placeholder?: string;
  initialValue?: string;
}

export interface SelectOrTypeResult {
  value: string;
  cancelled: boolean;
}

// Strip ANSI escape codes to get visible character count
function visibleLength(str: string): number {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Truncate a string to fit within maxWidth visible characters
function truncate(str: string, maxWidth: number): string {
  if (str.length <= maxWidth) return str;
  return str.slice(0, maxWidth - 1) + "…";
}

// Count how many terminal rows a string of visible length will occupy
function terminalRows(visibleLen: number, cols: number): number {
  if (visibleLen === 0) return 1;
  return Math.ceil(visibleLen / cols);
}

export async function selectOrType(options: SelectOrTypeOptions): Promise<SelectOrTypeResult> {
  const { message, suggestions, placeholder = "or type your own...", initialValue } = options;

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const cols = stdout.columns || 80;

    // Truncate suggestions to fit in the terminal
    const maxSuggestionWidth = cols - 20; // room for prefix + [tab to edit] + padding
    const displaySuggestions = suggestions.map((s) => truncate(s, maxSuggestionWidth));

    // State
    let selectedIndex = 0;
    let mode: "browse" | "type" = initialValue ? "type" : "browse";
    let customText = initialValue ?? "";
    let cursorPos = customText.length;
    let isFirstRender = true;
    let lastRenderedRows = 0; // track actual terminal rows rendered

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    function computeRenderedRows(): number {
      // Header
      let rows = terminalRows(visibleLength(`? ${message}`), cols);
      // Suggestions
      for (let i = 0; i < displaySuggestions.length; i++) {
        const isSelected = mode === "browse" && i === selectedIndex;
        const text = `  ${displaySuggestions[i]}${isSelected ? "  [tab to edit]" : ""}`;
        rows += terminalRows(text.length, cols);
      }
      // Divider
      rows += 1;
      // Input line
      const inputText = customText || placeholder;
      rows += terminalRows(inputText.length + 2, cols); // +2 for "> " prefix
      return rows;
    }

    function render() {
      // Move cursor back to the start of our render area
      if (!isFirstRender && lastRenderedRows > 1) {
        stdout.write(`\x1b[${lastRenderedRows - 1}A`);
      }

      // Header
      stdout.write(`${CLEAR_LINE}${CYAN}?${RESET} ${BOLD}${message}${RESET}\n`);

      // Suggestions (truncated to fit)
      for (let i = 0; i < displaySuggestions.length; i++) {
        const isSelected = mode === "browse" && i === selectedIndex;
        const prefix = isSelected ? `${GREEN}> ${RESET}` : "  ";
        const text = isSelected
          ? `${GREEN}${displaySuggestions[i]}${RESET}`
          : `${DIM}${displaySuggestions[i]}${RESET}`;
        const tabHint = isSelected ? `  ${DIM}[tab to edit]${RESET}` : "";
        stdout.write(`${CLEAR_LINE}${prefix}${text}${tabHint}\n`);
      }

      // Divider
      const divWidth = Math.min(50, cols);
      stdout.write(`${CLEAR_LINE}${DIM}${"─".repeat(divWidth)}${RESET}\n`);

      // Input line — truncate display if it would wrap
      const inputPrefix = mode === "type" ? `${YELLOW}> ${RESET}` : "  ";
      const maxInputWidth = cols - 4;
      let displayText: string;
      if (customText) {
        displayText = customText.length > maxInputWidth
          ? "…" + customText.slice(customText.length - maxInputWidth + 1)
          : customText;
      } else {
        displayText = mode === "type" ? "" : `${DIM}${placeholder}${RESET}`;
      }
      stdout.write(`${CLEAR_LINE}${inputPrefix}${displayText}`);

      // Position cursor within typed text
      if (mode === "type" && customText.length > 0) {
        const displayLen = Math.min(customText.length, maxInputWidth);
        const displayCursorPos = customText.length > maxInputWidth
          ? displayLen - (customText.length - cursorPos)
          : cursorPos;
        const moveBack = displayLen - Math.max(0, displayCursorPos);
        if (moveBack > 0) {
          stdout.write(`\x1b[${moveBack}D`);
        }
      }

      lastRenderedRows = computeRenderedRows();
      isFirstRender = false;
    }

    function cleanup() {
      stdin.setRawMode(wasRaw ?? false);
      stdin.removeListener("data", onData);
      stdout.write(SHOW_CURSOR);
    }

    function clearRenderArea() {
      if (lastRenderedRows > 1) {
        stdout.write(`\x1b[${lastRenderedRows - 1}A`);
      }
      for (let i = 0; i < lastRenderedRows; i++) {
        stdout.write(`${CLEAR_LINE}\n`);
      }
      if (lastRenderedRows > 0) {
        stdout.write(`\x1b[${lastRenderedRows}A`);
      }
    }

    function submit(value: string) {
      cleanup();
      clearRenderArea();

      // Show completed answer (truncated for display)
      const displayVal = value.length > cols - 10
        ? value.slice(0, cols - 13) + "..."
        : value;
      stdout.write(`${GREEN}+${RESET} ${BOLD}${message}${RESET} ${DIM}${displayVal}${RESET}\n`);

      resolve({ value, cancelled: false });
    }

    function cancel() {
      cleanup();
      clearRenderArea();
      resolve({ value: "", cancelled: true });
    }

    function onData(data: string | Buffer) {
      const key = data.toString();

      // Ctrl+C
      if (key === "\x03") { cancel(); return; }

      // Enter
      if (key === "\r" || key === "\n") {
        if (mode === "browse") {
          submit(suggestions[selectedIndex]); // submit full text, not truncated
        } else {
          submit(customText.trim() || suggestions[0]);
        }
        return;
      }

      // Tab
      if (key === "\t") {
        if (mode === "browse") {
          customText = suggestions[selectedIndex]; // full text for editing
          cursorPos = customText.length;
          mode = "type";
          stdout.write(SHOW_CURSOR);
          render();
        }
        return;
      }

      // Escape
      if (key === "\x1b" && data.length === 1) {
        if (mode === "type") {
          mode = "browse";
          customText = "";
          cursorPos = 0;
          stdout.write(HIDE_CURSOR);
          render();
        } else {
          cancel();
        }
        return;
      }

      // Arrow keys
      if (key.startsWith("\x1b[")) {
        const code = key.slice(2);
        if (code === "A" && mode === "browse") {
          selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
          render();
        } else if (code === "B" && mode === "browse") {
          selectedIndex = (selectedIndex + 1) % suggestions.length;
          render();
        } else if (code === "C" && mode === "type" && cursorPos < customText.length) {
          cursorPos++;
          render();
        } else if (code === "D" && mode === "type" && cursorPos > 0) {
          cursorPos--;
          render();
        }
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        if (mode === "type" && cursorPos > 0) {
          customText = customText.slice(0, cursorPos - 1) + customText.slice(cursorPos);
          cursorPos--;
          if (customText.length === 0) {
            mode = "browse";
            stdout.write(HIDE_CURSOR);
          }
          render();
        }
        return;
      }

      // Regular character
      if (key.length === 1 && key >= " ") {
        if (mode === "browse") {
          mode = "type";
          customText = "";
          cursorPos = 0;
          stdout.write(SHOW_CURSOR);
        }
        customText = customText.slice(0, cursorPos) + key + customText.slice(cursorPos);
        cursorPos++;
        render();
      }
    }

    stdout.write(HIDE_CURSOR);
    stdin.on("data", onData);
    render();
  });
}

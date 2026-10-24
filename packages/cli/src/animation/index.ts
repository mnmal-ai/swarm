// ---------------------------------------------------------------------------
// Swarm frames: braille-character swarm with 8 orbit positions
// ---------------------------------------------------------------------------

// The base swarm shape
const SWARM_LINES = [
  "  \u28E0\u28F6\u28FF\u28F6\u2844  ",
  " \u28FF\u28FF\u28FF\u28FF\u28FF\u28FF ",
  " \u28FF\u28FF\u28FF\u28FF\u28FF\u28FF ",
  "  \u283B\u28FF\u28FF\u281F  ",
];

// 8 orbit positions: [row, col] offsets for the dot relative to the swarm grid.
// Positions circle clockwise: top, top-right, right, bottom-right,
// bottom, bottom-left, left, top-left.
const ORBIT_POSITIONS: Array<[number, number]> = [
  [0, 4],   // top
  [0, 8],   // top-right
  [1, 9],   // right
  [3, 8],   // bottom-right
  [3, 4],   // bottom
  [3, 0],   // bottom-left
  [1, 0],   // left
  [0, 0],   // top-left
];

const FRAME_COUNT = ORBIT_POSITIONS.length;

// Frame height: swarm lines + 1 for the message line
const FRAME_HEIGHT = SWARM_LINES.length + 1;

// ANSI color helpers (avoid ESM import issues with picocolors)
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

function renderFrame(frameIndex: number, message: string): string {
  const [dotRow, dotCol] = ORBIT_POSITIONS[frameIndex % FRAME_COUNT];
  const lines: string[] = [];

  for (let row = 0; row < SWARM_LINES.length; row++) {
    const swarmLine = `${MAGENTA}${SWARM_LINES[row]}${RESET}`;

    if (row === dotRow) {
      const swarmWidth = SWARM_LINES[row].length;
      if (dotCol >= swarmWidth) {
        // Dot is to the right of the swarm
        const padding = " ".repeat(dotCol - swarmWidth);
        lines.push(`${swarmLine}${padding}${YELLOW}\u25CF${RESET}`);
      } else if (dotCol === 0) {
        // Dot is to the left of the swarm
        lines.push(`${YELLOW}\u25CF${RESET}${MAGENTA}${SWARM_LINES[row].slice(1)}${RESET}`);
      } else {
        lines.push(swarmLine);
      }
    } else {
      lines.push(swarmLine);
    }
  }

  // Message line below the swarm
  if (message) {
    lines.push(`${DIM}${message}${RESET}`);
  } else {
    lines.push("");
  }

  return lines.map((l) => `${l}\x1b[0K`).join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the swarm animation with an orbiting dot.
 *
 * Returns a stop function that clears the animation and restores the cursor.
 * In non-TTY environments, prints the message once and returns a no-op.
 */
export function startAnimation(message?: string): () => void {
  const msg = message ?? "";

  // Non-TTY: just print the message once and return a no-op
  if (!process.stdout.isTTY) {
    if (msg) {
      process.stdout.write(`${msg}\n`);
    }
    return () => {
      // no-op
    };
  }

  let frameIndex = 0;
  let isFirstRender = true;
  let stopped = false;

  // Hide cursor
  process.stdout.write("\x1b[?25l");

  const timer = setInterval(() => {
    if (stopped) return;

    // Move cursor up to overwrite previous frame (skip on first render)
    if (!isFirstRender) {
      process.stdout.write(`\x1b[${FRAME_HEIGHT}A`);
    }

    const frame = renderFrame(frameIndex, msg);
    process.stdout.write(`${frame}\n`);

    isFirstRender = false;
    frameIndex = (frameIndex + 1) % FRAME_COUNT;
  }, 120);

  // Return stop function
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);

    // Clear the animation: move up and clear each line
    if (!isFirstRender) {
      process.stdout.write(`\x1b[${FRAME_HEIGHT}A`);
      for (let i = 0; i < FRAME_HEIGHT; i++) {
        process.stdout.write("\x1b[0K\n");
      }
      // Move back up to where we started
      process.stdout.write(`\x1b[${FRAME_HEIGHT}A`);
    }

    // Show cursor
    process.stdout.write("\x1b[?25h");
  };
}

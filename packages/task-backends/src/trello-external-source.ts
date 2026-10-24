import type {
  ExternalItem,
  ExternalTaskSource,
  Goal,
  Task,
  TrelloStatusLists,
  ExternalItemStatus,
} from "@mnmal-ai/swarm-types";
import { runCli } from "./run-cli.js";
import { splitGoalFields } from "./labels.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TrelloExternalSourceOptions {
  /** argv of the project's Trello CLI, e.g. ["./bin/trello-cli"]. */
  command: string[];
  /** Directory the CLI runs in — the work repo root. */
  cwd?: string;
  /** Boards to take work from, in priority order. */
  boards: string[];
  /** Column swarm takes work from. Default: "To Do". */
  queueList?: string;
  /** Cards taken from the top of each board's queue. Default: 1. */
  perBoard?: number;
  /** Column a card moves to for each status. */
  lists?: TrelloStatusLists;
  /** Marker every comment starts with. Default: "[agent]". */
  commentMarker?: string;
}

const DEFAULT_LISTS: TrelloStatusLists = {
  in_progress: "Doing",
  completed: "Review",
  failed: "Blocked",
  merged: "Done",
};

const ACCEPTANCE_CHECKLIST = "Acceptance";
const ACCEPTANCE_HEADING = "## Acceptance";

// ---------------------------------------------------------------------------
// TrelloExternalSource — take goals from the top of a Trello column
// ---------------------------------------------------------------------------

/**
 * Implements ExternalTaskSource for Trello. Reads the top cards of each
 * board's queue column, turns each into a swarm Goal (acceptance criteria from
 * the card's Acceptance checklist, the card description as context), and moves
 * cards between columns as goals progress.
 *
 * Swarm never calls the Trello API directly. It runs the project's own Trello
 * CLI — the way GitHubExternalSource runs `gh` — so credentials and the list
 * of boards that may be touched stay with the project.
 *
 * Swarm does not create cards. Cards are written by people, to the project's
 * ticketing rules; swarm works them and reports on them.
 */
export class TrelloExternalSource implements ExternalTaskSource {
  readonly name = "trello";
  private readonly command: string[];
  private readonly cwd: string | undefined;
  private readonly boards: string[];
  private readonly queueList: string;
  private readonly perBoard: number;
  private readonly lists: TrelloStatusLists;
  private readonly commentMarker: string;

  constructor(options: TrelloExternalSourceOptions) {
    if (!options.command || options.command.length === 0) {
      throw new Error("TrelloExternalSource needs the Trello CLI command to run.");
    }
    if (!options.boards || options.boards.length === 0) {
      throw new Error("TrelloExternalSource needs at least one board to take work from.");
    }
    this.command = options.command;
    this.cwd = options.cwd;
    this.boards = options.boards;
    this.queueList = options.queueList ?? "To Do";
    this.perBoard = options.perBoard ?? 1;
    this.lists = { ...DEFAULT_LISTS, ...options.lists };
    this.commentMarker = options.commentMarker ?? "[agent]";
  }

  // -------------------------------------------------------------------------
  // ExternalTaskSource implementation
  // -------------------------------------------------------------------------

  async fetchItems(): Promise<ExternalItem[]> {
    const items: ExternalItem[] = [];
    for (const board of this.boards) {
      const cards = JSON.parse(await this.cli(["cards", board, "--list", this.queueList])) as TrelloCardSummary[];
      for (const card of cards.slice(0, this.perBoard)) {
        const detail = JSON.parse(await this.cli(["show", card.id])) as TrelloCardDetail;
        items.push(this.cardToItem(detail));
      }
    }
    return items;
  }

  parseGoal(item: ExternalItem): Goal {
    const { description, acceptance } = splitAcceptance(item.body);
    return {
      id: `trello-${item.externalId}`,
      description: item.title,
      priority: 0,
      status: "pending",
      constraints: [],
      acceptance_criteria: acceptance,
      context: `Card: ${item.url}\n\n${description}`.trim(),
      url: item.url,
      // No dependsOn: a card is only in the queue once nothing blocks it.
      // swarm_split: true / false overrides the project's decomposition policy.
      ...splitGoalFields(item.labels),
      // Kept for source_control.merge_prs.skip_labels.
      ...(item.labels.length > 0 ? { labels: [...item.labels] } : {}),
    };
  }

  async pushGoal(_goal: Goal): Promise<string> {
    throw new Error("TrelloExternalSource does not create cards; people write them to the project's ticketing rules.");
  }

  async pushTask(_task: Task, _parentGoalExternalId: string): Promise<string> {
    throw new Error("TrelloExternalSource does not create cards; swarm's tasks stay local.");
  }

  async updateStatus(externalId: string, status: ExternalItemStatus): Promise<void> {
    const list = this.lists[status];
    if (!list) return;
    await this.cli(["update", externalId, "--list", list]);
  }

  async postComment(externalId: string, comment: string): Promise<void> {
    const text = comment.startsWith(this.commentMarker) ? comment : `${this.commentMarker} ${comment}`;
    await this.cli(["comment", externalId, "--text", text]);
  }

  /** Move a card swarm started back to the column swarm took it from. */
  async returnToQueue(externalId: string): Promise<void> {
    await this.cli(["update", externalId, "--list", this.queueList]);
  }

  // -------------------------------------------------------------------------
  // Public helpers for bootstrap sync
  // -------------------------------------------------------------------------

  /**
   * Fetch the queued cards and parse them into Goals, in the order they
   * should run: by board, then by position in the column.
   */
  async fetchGoals(): Promise<Goal[]> {
    const items = await this.fetchItems();
    return items.map((item, index) => ({ ...this.parseGoal(item), priority: index }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Run the Trello CLI: asynchronously, with no shell (see runCli). */
  private async cli(args: string[]): Promise<string> {
    const [file, ...prefix] = this.command;
    try {
      return await runCli(file, [...prefix, ...args], { cwd: this.cwd });
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string | Buffer }).stderr?.toString().trim();
      const message = stderr || (err instanceof Error ? err.message : String(err));
      throw new Error(`Trello CLI failed (${args[0]}): ${message}`);
    }
  }

  private cardToItem(card: TrelloCardDetail): ExternalItem {
    const acceptance = (card.checklists ?? []).find((c) => c.name === ACCEPTANCE_CHECKLIST);
    const body = acceptance
      ? [
          card.desc.trimEnd(),
          "",
          ACCEPTANCE_HEADING,
          ...acceptance.items.map((i) => `- [${i.done ? "x" : " "}] ${i.name}`),
        ].join("\n")
      : card.desc;

    return {
      externalId: shortLinkOf(card.url) ?? card.id,
      title: card.name,
      body,
      state: card.archived ? "closed" : "open",
      labels: card.labels ?? [],
      url: card.url,
    };
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function shortLinkOf(url: string | undefined): string | undefined {
  return url?.match(/trello\.com\/c\/([A-Za-z0-9]+)/)?.[1];
}

/** Split the Acceptance section, which cardToItem appends last, off the body. */
function splitAcceptance(body: string): { description: string; acceptance: string[] } {
  const at = body.lastIndexOf(`\n${ACCEPTANCE_HEADING}\n`);
  if (at === -1) return { description: body, acceptance: [] };

  const acceptance: string[] = [];
  const regex = /^- \[[ x]\] (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body.slice(at))) !== null) {
    acceptance.push(match[1].trim());
  }
  return { description: body.slice(0, at).trimEnd(), acceptance };
}

// ---------------------------------------------------------------------------
// Internal types — the JSON the Trello CLI prints
// ---------------------------------------------------------------------------

interface TrelloCardSummary {
  id: string;
  url: string;
  board?: string;
  name: string;
  labels?: string[];
  list?: string;
  archived?: boolean;
}

interface TrelloCardDetail extends TrelloCardSummary {
  desc: string;
  checklists?: { name: string; items: { name: string; done: boolean }[] }[];
}

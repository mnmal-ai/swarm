// A stand-in for a project's Trello CLI (e.g. ./bin/trello-cli) for the two
// reads TrelloExternalSource makes. It prints the JSON such a CLI prints —
// `cards` summaries and `show` detail — from a fixture file, and refuses
// anything else, so a test fails loudly if swarm tries to write.
//
//   node fake-trello-cli.mjs <boards.json> cards <board> --list <column>
//   node fake-trello-cli.mjs <boards.json> show <card-id>
//
// boards.json: { "<board>": [ <card detail>, ... ] }

import { readFileSync } from "node:fs";

const [fixture, sub, target, ...rest] = process.argv.slice(2);
const boards = JSON.parse(readFileSync(fixture, "utf-8"));

function summary(card) {
  const { desc: _desc, checklists: _checklists, comments: _comments, ...rest } = card;
  return rest;
}

if (sub === "cards") {
  const at = rest.indexOf("--list");
  const list = at === -1 ? undefined : rest[at + 1];
  const cards = (boards[target] ?? []).filter((c) => list === undefined || c.list === list).map(summary);
  process.stdout.write(JSON.stringify(cards));
} else if (sub === "show") {
  const card = Object.values(boards).flat().find((c) => c.id === target);
  if (!card) {
    process.stderr.write(`No card ${target}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(card));
} else {
  process.stderr.write(`fake-trello-cli: "${sub}" is not a read this fixture allows\n`);
  process.exit(2);
}

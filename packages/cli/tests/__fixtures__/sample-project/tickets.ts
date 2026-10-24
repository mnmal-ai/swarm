/**
 * Invented ticket scenarios for the decomposition tests.
 *
 * Every card, plan and person here is made up, for a fictional library app:
 * members borrow and hold titles at two branches (Riverside, Hillcrest);
 * Priya is staff at Riverside, Tomás is a member at Riverside, Wen is a member
 * at Hillcrest.
 *
 * Each scenario is sized for what the tests measure: description length, the
 * number of Acceptance items, and — for S1 — a five-task plan whose intents
 * and complexity profile (bands, scores and signals) are fixed in S1_PROFILE.
 *
 * Cards are shaped like the JSON TrelloExternalSource reads from a Trello CLI:
 * `cards` prints summaries, `show` prints the detail with `desc`, `checklists`
 * and `comments`.
 */

export interface TrelloCardJson {
  id: string;
  url: string;
  board: string;
  name: string;
  labels: string[];
  list: string;
  desc: string;
  checklists: { name: string; items: { name: string; done: boolean }[] }[];
  comments: unknown[];
}

function acceptance(items: string[]): TrelloCardJson["checklists"] {
  return [{ name: "Acceptance", items: items.map((name) => ({ name, done: false })) }];
}

// ---------------------------------------------------------------------------
// S1 — permission bug card
// ---------------------------------------------------------------------------

const S1_DESC = `## Summary

Signed in as Tomás, a member at the Riverside branch, \`GET /members/{id}\` returns the full member record for any id he sends, not only his own. With Priya's id he gets her staff record: name, email, phone, home branch and staff role. With Wen's id he gets a Hillcrest member's contact details, her loan history and her place in the hold queue for two titles.

## Details

The route checks that a session exists and stops there. It never compares the member on the session with the member being read, and it never looks at the caller's branch. The two sub-routes under it, \`/members/{id}/loans\` and \`/members/{id}/holds\`, share the same lookup and the same gap. Member search (\`GET /members?q=\`) is worse: it returns every match across the library, with the same fields, to any signed-in member.

Ids are sequential, so the whole member list can be read by counting upwards. This turned up while testing the kiosk app, not from a member's complaint.

The web catalogue never links to another member's page, which is why nobody noticed: the gap only shows to someone calling the API directly. The kiosk app's member card screen does exactly that when staff scan a card, so scanning the wrong card at the desk is enough to show a stranger's record.

What should happen instead:

- A member can read their own record, their own loans and their own holds, and nobody else's.
- Staff can read the records, loans and holds of members registered at their own branch.
- Staff cannot read members registered at another branch through these routes; the inter-branch transfer flow has its own endpoint and is out of scope.
- Anyone else gets 404, with the same body as an id that does not exist, so ids cannot be probed.
- Search returns only members the caller may read, and the result count does not reveal how many were filtered out.
- The API decides before the record is loaded.

## To reproduce

1. Load the demo data: \`pnpm demo:load\`. It creates Priya (staff, Riverside), Tomás (member, Riverside) and Wen (member, Hillcrest).
2. Sign in as Tomás on the web catalogue and copy the session token from the network tab.
3. \`curl -H "Authorization: Bearer <token>" http://localhost:4000/members/<Priya's id>\` — 200, Priya's staff record.
4. The same with Wen's id — 200, Wen's record; add \`/loans\` — 200, her loan history.
5. \`curl -H "Authorization: Bearer <token>" "http://localhost:4000/members?q=a"\` — every member whose name contains "a", from both branches.
6. Sign out and repeat step 3 without a token — 401, which is correct.

## Notes

- \`src/members/member-routes.ts\` — the single-member route and its two sub-routes.
- \`src/members/member-access.ts\` — the lookup the routes share; the rule fits best here.
- \`src/search/member-search.ts\` — search builds its own query and returns rows as they come.
- \`src/auth/session.ts\` — gives us the caller's member id and branch; no change expected here.
- Web catalogue and kiosk app: both call these routes. Neither should need a change if allowed reads keep their current shape.
- Anything logged on a denied read must leave out contact details and loan titles.
- The kiosk app keeps the last record it showed on screen until the next scan; that is a separate card and not part of this fix.

## References

- Member records design — https://trello.com/c/Rv8cN2wQ
- Kiosk member card screen — https://trello.com/c/Pb4tH7xL
- Kiosk test session notes — https://trello.com/c/Jd2mS9kE
`;

export const S1_ACCEPTANCE = [
  "Tomás reading his own record gets it unchanged",
  "Tomás reading Priya's record gets 404",
  "An unknown id gets 404 with the same body as a forbidden one",
  "Priya (staff, Riverside) can read a Riverside member's record",
  "Priya reading Wen's record (Hillcrest) gets 404",
  "/loans and /holds under a member follow the same rule as the record",
  "Member search returns only members the caller may read",
  "Search result counts do not reveal filtered-out members",
  "The API decides access before the record is loaded",
  "A denied read is logged with caller id and requested id only",
  "Tests cover member, staff at the branch, staff elsewhere and no session",
  "The test suite passes",
];

export const S1_BUG_CARD: TrelloCardJson = {
  id: "5f3a9c01d2e4b7a8c9d0e1f2",
  url: "https://trello.com/c/Mx4qT8vB",
  board: "board-a",
  name: "Members can read other members' records",
  labels: ["area:members", "type:bug", "severity:high"],
  list: "To Do",
  desc: S1_DESC,
  checklists: acceptance(S1_ACCEPTANCE),
  comments: [],
};

/**
 * The planner's plan for S1, as its JSON answer: five tasks whose descriptions
 * score, with the unchanged scorer, 60, 50, 53 (moderate) and 73, 70
 * (complex), with conjunctions and description length maxed.
 */
export const S1_PLAN = {
  shared_files: [] as string[],
  tasks: [
    {
      title: "Trace how member lookups decide access",
      intent: "investigation",
      parallel: false,
      creates: [] as string[],
      modifies: [] as string[],
      description:
        "Read the member lookup path end to end and write down where access is decided. Start at the route in src/members/member-routes.ts and follow it into src/members/member-access.ts, and note every place a session is read, and every place a member id from the request is trusted, and whether the branch of the caller is ever compared with the branch of the member being read. Check the search endpoint and the loan-history and hold-queue sub-routes the same way, and list which of them share the lookup and which have their own query. Run the existing tests, and record which roles they cover and which they do not. Sign in as Tomás on the demo data, and confirm by hand that Priya's record comes back, and keep the request and response as evidence for the card. The output is a short written summary for the next task, not code.",
    },
    {
      title: "Put the member access rule in one place",
      intent: "implementation",
      parallel: false,
      creates: [] as string[],
      modifies: ["src/members/member-access.ts"],
      description:
        "Put the access rule in one place, next to the lookup in src/members/member-access.ts, so the route and the search both ask the same question. The rule is: a member may read their own record, and staff may read members registered at their own branch, and nobody else may read one. Take the caller from the session in src/auth/session.ts, and never from the request body or the query string, and return a plain result the route can act on rather than throwing. Keep the lookup query as it is, and do not widen what a staff session can see beyond its branch. Write the rule so that an unknown id and a forbidden id give the same answer, and so that nothing in the result says whether the id exists. Keep the function small and pure, and give it a name a reviewer will find when they search for member access.",
    },
    {
      title: "Check access in the member routes and search",
      intent: "implementation",
      parallel: false,
      creates: [] as string[],
      modifies: ["src/members/member-routes.ts", "src/search/member-search.ts"],
      description:
        "Wire the rule into the member routes so that the check runs on the server before any record is loaded, and fix the search so that it filters its results through the same rule instead of returning any match it finds. In src/members/member-routes.ts the single-member route, the loan-history route and the hold-queue route should call the rule first, and answer 404 with the same body for a forbidden id and an unknown id. Leave the response shape for allowed reads exactly as it is, so the web catalogue and the kiosk app need no change. Log a denied read with the caller's id and the requested id, and never with contact details or loan titles. Keep the diff to the routes and the search, and do not touch the session code or the lookup query, since the previous task settled both of them and the reviewer will compare against that.",
    },
    {
      title: "Test member reads for every role",
      intent: "implementation",
      parallel: false,
      creates: ["src/search/member-search.test.ts"],
      modifies: ["src/members/member-routes.test.ts", "src/test/demo-library.ts"],
      description:
        "Add tests for every role against the member routes, and make them fail on the code as it stood before this card and pass after it. In src/members/member-routes.test.ts cover a member reading their own record, a member reading another member, staff reading a member at their branch, staff reading a member at another branch, and a request with no session, and assert status and body in those cases, and assert that the forbidden and unknown cases are byte-for-byte equal. In src/search/member-search.test.ts cover search results for a member and for staff, and check that the count and the ids match the rule. Update the fixture in src/test/demo-library.ts so it creates Priya as staff at Riverside, Tomás as a member at Riverside and Wen as a member at Hillcrest, and use those three people in every case so the tests name who is asking.",
    },
    {
      title: "Review the member access change",
      intent: "code-review",
      parallel: false,
      creates: [] as string[],
      modifies: [] as string[],
      description:
        "Review the finished work against the card before it goes to a person. Check that each route, the search and both sub-routes decide access on the server, and that none of them trusts an id or a branch sent by the client, and that forbidden and unknown ids cannot be told apart. Confirm the tests fail on the old code, and pass on the new, and that they use the demo people. Read src/members/member-routes.ts for a path that loads a record before the rule runs. If something is wrong, fix it in place, or refactor the smallest part that makes it right, or remove dead code the work left behind, and note it.",
    },
  ],
};

/** The complexity profile the S1 plan is written to, task by task. */
export const S1_PROFILE = [
  { intent: "investigation", band: "moderate", score: 60 },
  { intent: "implementation", band: "moderate", score: 50 },
  { intent: "implementation", band: "moderate", score: 53 },
  { intent: "implementation", band: "complex", score: 73 },
  { intent: "code-review", band: "complex", score: 70 },
] as const;

// ---------------------------------------------------------------------------
// S2 — design card
// ---------------------------------------------------------------------------

const S2_DESC = `## Background

Members find out a loan is overdue when they next visit a branch, or when the overdue letter arrives. The library app knows every due date, but it tells nobody about one until the day has passed. Staff at Riverside say most overdue loans are less than a week late, and that a reminder a few days before the due date would prevent most of them. When Tomás asked at the desk why nothing had told him his loans were due, the only answer was that nothing ever does.

Due-date reminders are short messages, sent before a loan is due, that tell a member which titles are due, when, and whether each can be renewed. They exist so that members can return or renew on time without having to check, so that the desk spends less of its day on overdue loans, and so that titles with people waiting for them come back to the shelf sooner.

They also give the library one place to change how and when members hear about their loans. Today the only notice is the overdue letter, printed by a nightly job nobody has changed in years. It goes out a week after the due date, on paper, and staff say that by then most members have already been told at the desk.

This is a design card: the work is the written design, not the code. The cards that build it come afterwards and point back here.

## Approach

What the design covers:

- When a reminder is sent. The proposal is three days before the due date, and again on the due date for a loan that has not been returned or renewed by then.
- What a reminder says: each title due, its due date, the branch it belongs to, and whether it can be renewed, with a link to renew it in the web catalogue.
- How it is sent: by email to every member with an address on file, and by text message only to members who have asked for text messages.
- Grouping: one reminder per member per day, listing every loan due that day, rather than one message for each loan.
- Turning reminders off: a member can turn them off for themselves in their account settings. Staff cannot turn them off on a member's behalf.
- Quiet hours: no text message goes out between 21:00 and 08:00 in the branch's time zone. A message that falls in that window waits until 08:00.
- Loans that change after a reminder is queued: a renewal or a return drops that loan from the queued reminder, and a reminder with no loans left is not sent.
- A record of what was sent: the member id, the loan ids, the channel and the time, so the desk can answer "was I told?" without guessing.
- Volume: Riverside and Hillcrest together have about 1,200 loans due on a busy day, and the send job has to finish well before the branches open.
- Wording: plain and short, in the member's chosen language where the catalogue has a translation, and in English otherwise.
- Renewing from a reminder: the link opens the member's loans page with the due loans already selected, and asks the member to sign in first if needed.
- Failures: a reminder that cannot be sent is logged with the reason, and the desk sees a count of failed reminders each morning.
- Branch closures: when a branch is closed on the due date, the reminder says so and gives the next opening day.
- Test sends: staff can send a sample reminder to their own address from the settings page, to check the wording before it goes live.

What it leaves out:

- Messages about holds that are ready to collect. They are a separate message with rules of their own.
- Notifications in the kiosk app, which has no member session to send them to.
- Loan periods and renewal limits. A reminder reports them; it does not set them.
- The overdue letter. The nightly job keeps printing it until a later card replaces it.
- Any newsletter or event listing inside a reminder.
- Reminders to staff about loans they made on a member's behalf.

## Open points

1. Is three days the right lead time for every loan, or should the seven-day loans on new titles get their reminder one day before instead? The branch managers decide this, not engineering.
2. Should a member who has turned reminders off still get the message on the due date itself, as the one message the library always sends? If so, the settings page has to say so plainly.
3. Text messages are charged per message. Is there a monthly limit, and what happens to text reminders once it is reached?
4. When a loan cannot be renewed because someone else is waiting for the title, should the reminder say why, or only that it cannot be renewed?
5. What happens when an email bounces? The proposal is to stop emailing that address after three bounces, and to show a notice at the desk the next time the member borrows.
6. Should quiet hours follow the branch's time zone or the member's? Every branch is in one time zone today, so this only matters later.
7. Should the send job retry a text message that fails, and how many times? The proposal is two retries an hour apart, then an email instead.
8. Who can read the record of sent reminders? The proposal is staff at the loan's branch and the member, from their account page, and nobody else.
9. Should a reminder go to a member whose account is suspended? The proposal is yes, because the loans are still due, but without the renew link.

## Notes

- The member records design settles where contact details and account settings live, and the reminders read both from there.
- The overdue letter job already walks every loan each night; its query may be the starting point for the send job.
- Desk staff estimated, in a short survey in week 9, how many overdue loans are only a few days late. The numbers above come from it.
- Priya's notes on the renewal rules cover the fourth open point.
- The email provider's sending limits decide how the send job batches its messages.
- Wen asked in the members' survey for reminders by text message rather than email, which is why text is in the first version at all.
- The web catalogue's account page already lists loans with their due dates; the reminder link reuses that page rather than adding a new one.

## References

- Member records design — https://trello.com/c/Rv8cN2wQ
- Overdue letter job — https://trello.com/c/Gn2rY5uE
- Renewal rules notes — https://trello.com/c/Wf3nB6yR
- Desk survey, week 9 — https://trello.com/c/Hs5vD1cT
`;

export const S2_DESIGN_CARD: TrelloCardJson = {
  id: "5f3a9c02a1b2c3d4e5f60718",
  url: "https://trello.com/c/Ta6pJ3wZ",
  board: "board-a",
  name: "Write the due-date reminder design",
  labels: ["area:notifications", "type:design"],
  list: "To Do",
  desc: S2_DESC,
  checklists: acceptance([
    "The send times before and on the due date are stated",
    "The content of a reminder is listed item by item",
    "Email and text messages are described, with who gets which",
    "One reminder per member per day is specified",
    "Turning reminders off is described",
    "Quiet hours are stated, with the time zone they follow",
    "Dropping a loan from a queued reminder is specified",
    "The record of sent reminders is described, with who reads it",
    "Every open point says who decides it",
    "What the design leaves out is listed",
    "The cards that will build it are named",
    "Priya has reviewed the design",
  ]),
  comments: [],
};

// ---------------------------------------------------------------------------
// S3 — feature card, and S4 — the same card with conflicting labels
// ---------------------------------------------------------------------------

const S3_DESC = `## Summary

New copies reach the shelves without a barcode label the library app can read. Staff at each branch print labels from a desktop tool written for the old catalogue, type each copy number in by hand, and stick the label on. When a number is mistyped the copy cannot be checked out until someone at the desk finds the right record, and a copy with the wrong label can be checked out as a different title. Last month Hillcrest found eleven copies labelled with numbers that belonged to Riverside. It also takes time: at Riverside, labelling a delivery of new copies takes most of a morning, and at Hillcrest it is done at the end of the day, when mistakes are more likely.

This card adds label printing to the library app: when staff add a copy, the app prints a label from the copy number it already holds, and a check fails when the catalogue holds a copy whose number could not be printed as a readable barcode.

Nothing here changes how copies are numbered; the gap is that numbers and labels come from two places that never compare notes.

## Approach

Labels are printed from the copy screen in the staff desk, \`src/copies/copy-screen.ts\`, and from a batch page used after a delivery of new copies. The batch page lists the copies added since the last batch, and staff can untick any copy they do not want to print yet, and print the rest. Every label carries the same fields, in the same order:

- Barcode: the copy number, encoded as Code 128.
- Copy number: the same number in plain text under the barcode.
- Title: up to 40 characters of the title, cut at a word.
- Shelf mark: the classification the catalogue holds for the title.
- Branch: the short code of the branch that owns the copy.
- Printed: the day the label was printed.

A new module, \`src/labels/label-layout.ts\`, turns a copy into a label, and \`src/labels/label-printer.ts\` sends a page of labels to the branch printer. The layout is a pure function, so it can be tested without a printer; the printer module is the only part that talks to hardware.

A check runs with the test suite. It reads every copy number in the catalogue fixture, encodes each one with the code the layout uses, and fails when a number cannot be encoded, is longer than a label allows, or is shared by two copies. It does not look at the printed page; staff check that by eye the first time a branch prints.

Printing never changes a copy record. If the copy screen cannot print, the copy is still saved, and its label can be printed later from the same screen.

## Users

Branch staff, such as Priya at Riverside, print the labels. They add copies one at a time from the copy screen, or in a batch after a delivery, and reprint a label when one is torn or smudged. They cannot change a copy number from the label page: a wrong number is corrected on the copy record, and the label printed again.

Members, such as Tomás and Wen, see nothing new in the catalogue. They notice only that a checkout at the kiosk scans the first time.

Branch managers see the number of labels printed each week, and the number reprinted, on the branch dashboard, and can ask for a reprint of a whole shelf.

Engineers keep the layout and the check in step. A change to the label fields or to the barcode format is made in the layout module, and the check runs against that same code, so the two cannot drift apart.

## Details

What the first version must handle:

- Single labels: one label printed from the copy screen, straight after the copy is saved.
- Batches: up to 200 labels printed from the batch page, in the order the copies were added.
- Reprints: a label printed again for an existing copy, with the new print date.
- Label stock: the two sheet sizes the branches use today, 21 and 65 labels per sheet.
- Part-used sheets: a batch can start at any position on a sheet, so a half-used sheet is not thrown away.
- Printers: one printer per branch, named in the branch settings.
- Preview: a batch shows each sheet before it prints.
- Fonts: the plain-text lines use the printer's built-in font, and nothing is embedded, so labels print the same at both branches.
- Barcode size: at least 25 mm wide and 10 mm tall, so the kiosk scanners and the desk scanners read it from a normal distance.
- The catalogue fixture: the check reads \`test/fixtures/catalogue.json\`, which holds copies from both branches.
- Existing labels: copies labelled by the old tool keep their labels; nothing is reprinted unless staff choose to.

For each sheet size the layout records the margins, the number of columns and rows, and the gap between labels. The two known problems are the 65-label sheet, where long shelf marks do not fit, and the old tool's numbers, some of which start with a letter.

## Edge cases

- A copy number is too long for a label: the layout shortens nothing; the copy screen shows the error, and the check fails on the same copy.
- A title is longer than 40 characters: the layout cuts it at the last whole word and adds an ellipsis.
- A delivery holds more than 200 copies: the batch page splits it into batches of 200 and prints them in order, and staff can stop between batches.
- The printer runs out of labels part-way through a batch: the copy screen shows which labels printed and which did not, and staff reprint from there.
- The branch printer is offline: the batch waits in a queue on the copy screen and prints when the printer is back, and staff can cancel it while it waits.
- Two staff print batches from the same delivery at the same time: each batch lists only the copies it was given, so no copy is printed twice unless someone asks for a reprint.
- A copy is withdrawn after its label was printed: the label is not recalled; the kiosk refuses the barcode, and the desk sees why.
- The sheet size in the settings does not match the stock in the printer: the preview shows the layout, and staff can change the size before printing.
- A shelf mark is missing: the label prints without it, and the copy screen flags the copy for someone to fill in.
- A copy number from the old tool starts with a letter: it is encoded as it is, and the check treats it like any other number.

## References

- Copy records design — https://trello.com/c/Rv8cN2wQ
- Kiosk checkout screen — https://trello.com/c/Pb4tH7xL
- Branch printer settings — https://trello.com/c/Wf3nB6yR
- Hillcrest's mislabelled copies, written up — https://trello.com/c/Lc9eF4hS
`;

export const S3_ACCEPTANCE = [
  "src/labels/label-layout.ts turns a copy into a label",
  "Every label has the six fields, in order",
  "The barcode is Code 128 and matches the copy number",
  "Titles longer than 40 characters are cut at a word",
  "A single label prints from the copy screen after saving",
  "A batch of up to 200 labels prints from the batch page",
  "A label can be reprinted with a new print date",
  "Both sheet sizes, 21 and 65 labels, are supported",
  "A batch can start part-way through a sheet",
  "The batch page previews each sheet",
  "An offline printer queues the batch, and staff can cancel it",
  "The check reads every copy number in the catalogue fixture",
  "The check fails on a number that cannot be encoded",
  "The check fails on a number shared by two copies",
  "A missing shelf mark still prints a label and flags the copy",
  "Printing never changes a copy record",
  "Copies labelled by the old tool are left as they are",
  "The test suite passes",
];

export const S3_FEATURE_CARD: TrelloCardJson = {
  id: "5f3a9c06b7c8d9e0f1a2b3c4",
  url: "https://trello.com/c/Kq7Lm2Pa",
  board: "board-a",
  name: "Add barcode labels for new copies",
  labels: ["area:catalogue", "type:feature"],
  list: "To Do",
  desc: S3_DESC,
  checklists: acceptance(S3_ACCEPTANCE),
  comments: [],
};

/** The same card under a different set of labels. */
export const S3_FEATURE_CARD_RELABELLED: TrelloCardJson = {
  ...S3_FEATURE_CARD,
  id: "5f3a9c07c8d9e0f1a2b3c4d5",
  url: "https://trello.com/c/Yh8sW1qN",
  labels: ["type:feature", "milestone:next"],
};

/** The same card with extra labels (e.g. swarm_split). */
export function withLabels(card: TrelloCardJson, ...labels: string[]): TrelloCardJson {
  return { ...card, labels: [...card.labels, ...labels] };
}

/** S4: S3 carrying both swarm_split labels. */
export const S4_CONFLICT_CARD: TrelloCardJson = withLabels(S3_FEATURE_CARD, "swarm_split: true", "swarm_split: false");

// ---------------------------------------------------------------------------
// GitHub-issue variants, shaped like `gh issue list --json …`
// ---------------------------------------------------------------------------

export interface GitHubIssueJson {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: { name: string }[];
  url: string;
}

/** A card as the GitHub issue a project on GitHub Issues would file. */
export function asGitHubIssue(card: TrelloCardJson, number: number, extraLabels: string[] = []): GitHubIssueJson {
  const items = card.checklists.find((c) => c.name === "Acceptance")?.items ?? [];
  return {
    number,
    title: card.name,
    body: [card.desc.trimEnd(), "", "## Acceptance Criteria", ...items.map((i) => `- [ ] ${i.name}`), ""].join("\n"),
    state: "OPEN",
    labels: ["swarm:goal", ...card.labels, ...extraLabels].map((name) => ({ name })),
    url: `https://github.com/example/sample-project/issues/${number}`,
  };
}

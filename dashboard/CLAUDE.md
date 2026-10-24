# CLAUDE.md

This is the **Swarm Dashboard** — a React SPA that visualizes telemetry emitted by the Swarm SDK.

## What This Does

Displays three views of swarm system health:
- **Health**: First-pass acceptance rate, arbiter rate, escalation rate, weekly trends, performance by mode.
- **Models**: Side-by-side model comparison table, token-performance tradeoff chart.
- **Oversight**: Resolution funnel showing how sessions flow through worker → reviewer → arbiter → human.

## Live Dashboard (Embedded in SDK)

The swarm now ships its own embedded live dashboard at `localhost:3141` that shows real-time tool calls, swarm context (intent + files loaded), agent role badges (Worker/Reviewer/Arbiter), token usage, a streaming event log, a Substrate Store panel (entity counts and timing breakdown). That live dashboard is a self-contained HTML file inside the swarm repo and is designed for real-time monitoring during an active agent session.

This swarm-dashboard repo is a separate, post-mortem analytics dashboard. It reads telemetry from Substrate entities and displays historical trends, model comparisons, and oversight resolution funnels. The two dashboards serve complementary purposes: the SDK's embedded dashboard is for live observation; this dashboard is for retrospective analysis.

## Current Status

v0.1.0 — Built with sample data. Reads from telemetry summaries. Not yet wired to production aggregated data.

## Project Structure

```
src/
├── App.jsx               # Root component, renders SwarmDashboard
├── components/
│   └── SwarmDashboard.jsx  # Main dashboard with all three tabs
├── data/
│   └── sample-data.js    # Sample telemetry data for development
└── index.jsx             # Entry point
public/
└── index.html            # HTML shell
```

## Data Source

The swarm emits two kinds of telemetry: (1) real-time events via its embedded SwarmEventBus, which feeds the live dashboard at `localhost:3141`, and (2) Substrate entities (`SessionEvent`, `OversightChain`, `TranscriptEntry`) written to Postgres via the Substrate sidecar. This swarm-dashboard reads telemetry from Substrate via a proxy route (`/api/substrate/query`).

Currently uses hardcoded sample data in `src/data/sample-data.js`. In production:
1. The swarm writes telemetry as Substrate entities to Postgres
2. This dashboard queries Substrate directly — no aggregation step needed
3. For offline/demo use, falls back to summary JSON files

## Companion Repos

- `swarm` — The swarm content repo (context files, routing config, test definitions, telemetry schemas).
- `swarm` — v0.1.0 — functional, includes embedded live dashboard for real-time monitoring. TypeScript library that wraps agent calls and emits the telemetry this dashboard visualizes.

## Tech Stack

- React 18
- Recharts (charts)
- Vite (build tool)
- No CSS framework — inline styles over the Axon design tokens (`src/axon/`, vendored, see `src/theme.js`)

## Build Commands

```bash
npm install         # Install dependencies
npm run dev         # Dev server on localhost:5173
npm run build       # Production build to dist/
npm run preview     # Preview production build
```

## Design Decisions

- Axon design system, as in swarm's live dashboard: dark and light themes follow `prefers-color-scheme`, surfaces are neumorphic, cards rise in and sink when pressed (no motion under `prefers-reduced-motion`).
- Axon status colours: cyan = active or pending, amber = in progress or token usage, green = success, magenta = failure.
- All metric cards show current value, trend delta, and target threshold.
- The component is also renderable as a standalone React artifact (the .jsx file works in Claude's artifact renderer).

## Pull Request Workflow

When Claude Code opens a pull request, it must always:

1. **Open the PR** with a clear title, summary, and test plan.
2. **Wait for CI to finish** — do not move on until all checks pass or fail.
3. **Address all review feedback** — fix issues, push updated commits.
4. **Resolve review conversations** — ensure all threads are addressed.
5. **Push the final state** and verify CI passes again.
6. **Notify the user** that the PR is ready for human review.

## Versioning

This repo uses [semantic-release](https://github.com/semantic-release/semantic-release) for automated versioning. Every merge to `main` triggers a release based on conventional commit prefixes:

- `feat:` → minor bump (0.1.0 → 0.2.0)
- `fix:` → patch bump (0.1.0 → 0.1.1)
- `feat!:` or `BREAKING CHANGE:` in body → major bump (but avoided in 0.x)
- `chore:`, `docs:`, `test:`, `ci:` → no release

**Rules for LLMs and agents:**
- Always use conventional commit prefixes. Every commit message must start with a type.
- Use `feat:` for new dashboard features (new visualizations, new tabs, new data integrations).
- Use `fix:` for bug fixes to existing charts, layouts, or data handling.
- Use `chore:` for config, CI, dependency updates, and non-functional changes.
- Use `docs:` for documentation-only changes.
- Never manually edit the version in package.json — semantic-release manages it.
- Never manually create git tags — semantic-release manages them.
- The CHANGELOG.md is auto-generated. Do not edit it manually.

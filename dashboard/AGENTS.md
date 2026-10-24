# AGENTS.md

## Project

The **Swarm Dashboard** is a React SPA that visualizes telemetry from the Swarm system. It reads structured JSON summary data and displays health metrics, model comparisons, and oversight resolution funnels.

## Tech Stack

- Framework: React 18
- Charts: Recharts
- Build: Vite
- Styling: Inline styles over Axon design tokens (`src/axon/`, vendored); no CSS framework
- Package manager: npm

## Repo Layout

- `src/App.jsx` — Root component
- `src/components/SwarmDashboard.jsx` — Main dashboard with Health, Models, Oversight tabs
- `src/data/sample-data.js` — Sample telemetry data for development
- `src/index.jsx` — Entry point
- `public/index.html` — HTML shell

## Conventions

- All styling uses inline style objects over the Axon tokens in `src/theme.js` (`COLORS`, `TONES`, `SANS`, `MONO`). `src/axon.css` loads the tokens (dark, and light under `prefers-color-scheme: light`) and holds the few rules inline styles cannot express: neumorphic surfaces, entry and press motion, buttons, reduced motion. Never hardcode a colour, shadow, duration or easing.
- DM Sans (`SANS`) for all text; DM Mono (`MONO`) for every number, timestamp, identifier and token count.
- Status colours follow Axon and are never decorative: cyan = active or pending, amber = in progress or token usage, green = success, magenta (`--purple`) = failure. Red is reserved for destructive actions.
- All metric thresholds come from `swarm/telemetry/alerts.json` in the swarm repo.
- The dashboard component is designed to also work as a standalone Claude artifact (.jsx).

## Data Flow

There are two telemetry paths:

```
Real-time:    swarm → SwarmEventBus → DashboardServer (localhost:3141)
Post-mortem:  swarm → Substrate entities (Postgres) → /api/substrate/query → this dashboard
```

The swarm's embedded live dashboard (`src/server/dashboard.html` in swarm) is a separate, self-contained HTML file for real-time monitoring during active agent sessions. It includes a Substrate Store panel. This swarm-dashboard repo is the React SPA for historical/aggregate analysis.

Currently uses sample data. Production integration queries Substrate entities via the proxy route.

## Do Not

- Do not add a CSS framework. The inline style system is intentional for artifact compatibility.
- Do not add authentication — this is an internal tool.
- Do not hardcode metric thresholds in the dashboard. They should match `swarm/telemetry/alerts.json`.
- Do not remove the sample data — it's needed for development and demos.

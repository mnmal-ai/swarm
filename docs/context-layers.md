# Context Layers

Swarm organizes knowledge in concentric layers, loaded from innermost (always) to outermost (budget permitting). No agent reads all files — the router ensures each invocation loads only what's relevant.

## The Seven Layers

| # | Layer | Path | Required? | Description |
|---|---|---|---|---|
| 1 | **Core** | `core/` | Always | Values, rules, voice. ~2,000 tokens. Non-negotiable. |
| 2 | **Mode** | `modes/` | Always | Behavioral context for the classified intent (code-review, implementation, investigation, orchestration). |
| 3 | **Oversight** | `oversight/` | Always | Review policy — defines Worker/Reviewer/Arbiter rules. |
| 4 | **Capabilities** | `capabilities/` | If budget allows | How-to docs (git workflow, testing standards). |
| 5 | **Domain** | `domains/{project}/` | If budget allows | Project-specific architecture, conventions, constraints. |
| 6 | **Skills (Vetted)** | `skills/vetted/` | If budget allows | Third-party knowledge, reviewed and adopted. |
| 7 | **Skills (Community)** | `skills/community/` | Never auto-loaded | Reference only. Agents can suggest promotion to vetted. |

## Context Budget

Models degrade as context fills up (the "lost-in-the-middle" phenomenon). The swarm enforces per-model token limits to prevent this.

| Model | Budget |
|---|---|
| `claude-opus-4-6` | 20,000 tokens |
| `claude-sonnet-4-6` | 14,000 tokens |
| Default (any other) | 15,000 tokens |

Loading priority: required tiers always load. Optional tiers fill in by priority order until the budget is exhausted. If a file would push past the budget, it's skipped.

Token estimation uses a rough 1 token ≈ 4 characters heuristic. Good enough for budgeting.

## How Routing Works

At runtime, the SDK queries `SwarmRoute` entities from Substrate instead of reading `swarm.json` from disk. Each `SwarmRoute` entity contains `intent`, `keywords`, `contentPaths`, and a `description`.

`swarm.json` remains the **seed source** — it is the human-authored file in the `.swarm/` directory. On first run, routes are seeded into Substrate as `SwarmRoute` entities. After seeding, Substrate is the runtime truth.

Example route entity:

```json
{
  "intent": "review code",
  "keywords": "[\"review\", \"pr\", \"pull request\", \"diff\"]",
  "contentPaths": "[\"core/values.md\", \"core/rules.md\", \"core/voice.md\", \"modes/code-review.md\", \"capabilities/git-workflow.md\"]"
}
```

The SDK queries all `SwarmRoute` entities, scores the user's prompt against keyword lists, picks the highest-scoring route, then queries `SwarmContent` entities matching the resolved paths. Token budget enforcement is the same algorithm — load in priority order until the budget is full.

Token estimation still uses 1 token ≈ 4 characters, and the `tokenEstimate` is stored as a field on each `SwarmContent` entity.

## Skills Tiers

Third-party knowledge is organized by trust level:

- **Core** (`skills/core/`) — Team-authored, fully tested. Always loaded if route specifies.
- **Vetted** (`skills/vetted/`) — Third-party, reviewed and adopted. Loaded by default. Must have at least one behavioral test.
- **Community** (`skills/community/`) — Reference only. Not loaded by default.

When conflicts exist: Core > Vetted > Community. More specific > more general. Domain > Mode > Core.

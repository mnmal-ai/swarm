---
name: postmortem-from-prs
description: Build an incident or release postmortem by mining recent merged PRs, commits, and issue threads. Use after a regression, incident, or release to reconstruct what changed, when, and why.
---

# Skill: Postmortem from PRs

<!-- DRAFT scaffolded by /prepare-for-swarm (skill axis). Adapt to your git host and PR
     conventions before trusting the swarm to summarize an incident. -->

## When this loads

The swarm detected a git repository / GitHub remote. Loads when reconstructing what
happened around an incident, regression, or release from version-control history.

## Inputs

- A time window or release tag bounding the incident.
- The symptom (what broke, when it was first observed).
- Optionally, a suspected area of the codebase.

## Workflow

1. List merged PRs and commits in the window (`git log`, `gh pr list --state merged`).
2. For each candidate, capture: title, author, files touched, and the stated *why* from the PR body.
3. Cross-reference with linked issues for prior context.
4. Build a timeline: change merged -> deployed -> symptom observed.
5. Identify the most likely causal change and the gap that let it ship (missing test, skipped gate, unreviewed area).
6. Write the postmortem: summary, timeline, root cause, contributing factors, and concrete follow-up actions.

## Output shape

- **Summary** — one paragraph: what broke and impact.
- **Timeline** — timestamped events.
- **Root cause** — the change and the mechanism.
- **Contributing factors** — what allowed it (process or coverage gaps).
- **Action items** — specific, owned, each preventing a recurrence.

## Guardrails

- Blameless: name changes and gaps, not people.
- No PII or secrets in the writeup. Reference commits by hash, not author contact details.

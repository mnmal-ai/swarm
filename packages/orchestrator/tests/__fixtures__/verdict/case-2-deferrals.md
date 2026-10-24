# Evidence README — task-8 (Layer 2d observability)

| Sub-check | Verdict |
|---|---|
| (a) Vercel env vars set | PASS |
| (c) Forced exception lands in Sentry | PARTIAL / HUMAN-DEFERRED |
| (d) /resolve writes lookup_log | PASS (Postgres-side) |
| (d) lookup_log mirrored to Axiom | HUMAN-DEFERRED |
| (e) PII audit (static + unit) | PASS |
| (e) PII audit (100-event sample) | HUMAN-DEFERRED |

HUMAN-DEFERRED items require read-side auth tokens (Sentry Issues API, Axiom
Datasets API) that are not in the agent's scope per rules.md "Never log env-var values".
Deferred to operator: goal-23-task-18 (observability operator sign-off).

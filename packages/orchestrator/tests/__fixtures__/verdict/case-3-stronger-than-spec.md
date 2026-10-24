# Evidence README — task-9 (Layer 2e cron + cap)

| Sub-check | Verdict |
|---|---|
| Cron registration | PASS |
| Prod gate | PASS (404, stronger than spec's 403) |
| Cap count | PASS |
| At-cap behavior | PASS |

All 4 sub-checks pass. The prod gate returns 404 instead of the spec's 403 —
this is a stronger gate (resource not found vs. forbidden), documented here:
`src/api/routes/cron.ts:L88` — early 404 return before auth check.

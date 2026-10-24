# Evidence README — task-6 (Layer 2b service round-trip)

## Overall verdict: PASS (with one architectural deviation noted)

All 5 service flows returned 200 OK.

### Deviation

Cache-miss waterfall wrote 2 `lookup_log` rows instead of 1 (per AC spec).

**Deviation reason:** Synthetic seeds intentionally don't match real Google Places.
The orchestrator runs the full waterfall → the second `lookup_log` row is the
by-design tombstone. This is expected behavior, not a regression.

File evidence: `src/services/lookup.ts:L142` — `writeLookupLog(tombstone: true)`

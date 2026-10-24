# Retain Cycle Test App

Test Swift project with deliberate memory management bugs for validating the swarm system's code review capabilities.

## Swarm Integration

- Swarm content: the directory `SWARM_PATH` names (the integration tests default to `tests/fixtures/content`)
- Swarm SDK: this repository

## Known Bugs (for testing)

1. **ProfileViewModel.swift** — Closure captures `self` strongly, creating a retain cycle. Should use `[weak self]`.
2. **NotificationService.swift** — Strong delegate reference (should be `weak var delegate`). Also missing `deinit` to remove `NotificationCenter` observers.

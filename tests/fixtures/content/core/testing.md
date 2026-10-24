# Testing

- Every behaviour change ships with a test that fails without it.
- Test behaviour through the public interface, not private helpers.
- Keep tests independent: no shared mutable state, no reliance on run order.
- Use temporary directories and fake clocks instead of the real filesystem and time.
- A flaky test is a bug. Fix the cause; do not add retries.

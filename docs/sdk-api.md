# SDK API

The Swarm SDK can be used programmatically in TypeScript applications. The CLI (`swarm run`) uses these APIs internally.

## Basic Usage

The `Swarm` constructor takes its config plus a `deps` object whose `queryClient` is a `SubstrateClient`. The `swarmPath` is still accepted as the filesystem fallback and seed source, but the Substrate store is the runtime truth for all context loading, routing, and telemetry.

```typescript
import { Swarm } from '@mnmal-ai/swarm';
import { SubstrateClient } from '@mnmal-ai/swarm-substrate';

// The cold sidecar listens on 32338 (`swarm substrate start` brings it up).
const queryClient = new SubstrateClient('http://localhost:32338');

const swarm = new Swarm({
  swarmPath: './.swarm',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY,
}, { queryClient });

const result = await swarm.run('Review this Swift PR for issues', {
  input: diffString,
  project: 'ios-app',
});

console.log(result.output);          // Agent's response
console.log(result.intent);          // Classified intent (e.g., "code-review")
console.log(result.filesLoaded);     // Swarm files used
console.log(result.tokensUsed);      // Context budget consumption
```

## SubstrateClient

The `SubstrateClient` handles all communication with a Substrate sidecar over HTTP. It exposes `query()` and `mutate()` with selective field access. `query()` follows page cursors when you pass neither `limit` nor `cursor`, and every mutate carries its idempotency key inside the frame:

```typescript
import { SubstrateClient } from '@mnmal-ai/swarm-substrate';

const client = new SubstrateClient('http://localhost:32338'); // namespace defaults to "swarm"

// Query swarm routes
const routes = await client.query('SwarmRoute', {}, { intent: true, keywords: true, contentPaths: true });

// Write a telemetry event (numeric fields are numbers)
await client.mutate('createSessionEvent', {
  sessionId: 'sess-123', role: 'worker', intent: 'code-review', inputTokens: 1200, outputTokens: 300,
}, { id: true });
```

Transport is HTTP only. `subscribeOrPoll` polls; there is no push channel.

## With Oversight

```typescript
const result = await swarm.runWithOversight('Fix the login timeout bug', {
  input: issueDescription,
  project: 'ios-app',
});

console.log(result.output);                    // Final approved output
console.log(result.oversight.verdict);          // "approved" | "rejected" | "escalate"
console.log(result.oversight.retryCount);       // Number of retry attempts
console.log(result.oversight.arbiterInvolved);  // boolean
console.log(result.oversight.humanEscalation);  // boolean
```

## Benchmarking

Run behavioral tests across models to compare quality:

```typescript
import { BenchmarkRunner } from '@mnmal-ai/swarm';

const runner = new BenchmarkRunner({
  swarmPath: './swarm',
  testsPath: './swarm/tests/behavioral',
});

// Run all tests against a model
const results = await runner.runSuite({
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  runsPerTest: 5,
});

// Compare two models
const comparison = await runner.compare(
  { provider: 'anthropic', model: 'claude-opus-4-6' },
  { provider: 'anthropic', model: 'claude-opus-5' },
);
```

## Multi-Task Workflows

The orchestrator manages goals that contain multiple tasks with dependencies.

### Task Dependencies (DAG)

Tasks declare `dependsOn` relationships forming a directed acyclic graph. The orchestrator topologically sorts them into execution tiers:

```typescript
import { topologicalSort } from '@mnmal-ai/swarm-orchestrator';

const tasks = [
  { id: 'scaffold', name: 'Create project structure' },
  { id: 'models', name: 'Define data models', dependsOn: ['scaffold'] },
  { id: 'api', name: 'Build API endpoints', dependsOn: ['models'] },
  { id: 'tests', name: 'Write tests', dependsOn: ['models'] },
];

const tiers = topologicalSort(tasks);
// tier 0: ['scaffold']      — runs first
// tier 1: ['models']        — runs after scaffold
// tier 2: ['api', 'tests']  — run in parallel after models
```

### Failure-Driven Replanning

After a goal completes, failures are categorized and the system decides what to do next:

```typescript
import { analyzeGoalResults } from '@mnmal-ai/swarm-orchestrator';

const decisions = analyzeGoalResults(taskResults);
// Each decision has an action:
//   'no_action'          — task succeeded
//   'retry_decomposed'   — break into subtasks and retry
//   'escalate_human'     — needs human intervention
//   'fold_into_next_goal' — carry forward as constraint
```

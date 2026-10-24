/**
 * DAG (Directed Acyclic Graph) utilities for task dependency ordering.
 *
 * Pure functions for validating, sorting, and querying task dependency graphs.
 * Used by the orchestrator to dispatch tasks in the correct order, respecting
 * dependency relationships while maximizing parallelism within each tier.
 */

import { matchesGlob } from "@mnmal-ai/swarm-types";

// Re-export so existing consumers of `matchesGlob` from this module still work.
export { matchesGlob };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DAGNode {
  id: string;
  dependsOn: string[];
  /** Files this task expects to modify. Used by serialization constraints
   *  AND create→modify dependency inference. Any file a task will modify
   *  must be listed here for conflict prevention to work — even if this
   *  task is the only writer. */
  serializedFiles?: string[];
  /** Files this task expects to create. Tasks that modify these files should depend on this task. */
  createsFiles?: string[];
}

export interface DAGValidationResult {
  valid: boolean;
  error?: string;
}

export interface ExecutableTasksResult {
  /** Tasks whose dependencies are all satisfied (in `completed`). */
  executable: string[];
  /** Tasks with unsatisfied dependencies that haven't failed. */
  blocked: string[];
  /** Tasks with at least one failed dependency — will never become executable. */
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that the DAG has no cycles and all referenced dependency IDs exist
 * in the node list.
 *
 * Returns `{ valid: true }` when the graph is well-formed, or
 * `{ valid: false, error: "..." }` describing the first problem found.
 */
export function validateDAG(nodes: DAGNode[]): DAGValidationResult {
  if (nodes.length === 0) {
    return { valid: true };
  }

  const idSet = new Set(nodes.map((n) => n.id));

  // Check for duplicate IDs
  if (idSet.size !== nodes.length) {
    const seen = new Set<string>();
    for (const node of nodes) {
      if (seen.has(node.id)) {
        return { valid: false, error: `Duplicate node ID: "${node.id}"` };
      }
      seen.add(node.id);
    }
  }

  // Check that all referenced dependencies exist
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!idSet.has(dep)) {
        return {
          valid: false,
          error: `Node "${node.id}" depends on "${dep}", which does not exist`,
        };
      }
    }
  }

  // Check for cycles using DFS with coloring:
  //   white = unvisited, gray = in current path, black = fully processed
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();

  for (const node of nodes) {
    color.set(node.id, WHITE);
  }

  // Build adjacency: node → its dependencies (edges we traverse for cycle detection)
  const adjMap = new Map<string, string[]>();
  for (const node of nodes) {
    adjMap.set(node.id, node.dependsOn);
  }

  function dfs(nodeId: string, path: string[]): string | null {
    color.set(nodeId, GRAY);
    const deps = adjMap.get(nodeId) ?? [];
    for (const dep of deps) {
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        // Found a cycle — build a readable cycle path
        const cycleStart = path.indexOf(dep);
        const cyclePath = [...path.slice(cycleStart), dep];
        return `Cycle detected: ${cyclePath.join(" -> ")}`;
      }
      if (depColor === WHITE) {
        const result = dfs(dep, [...path, dep]);
        if (result) return result;
      }
    }
    color.set(nodeId, BLACK);
    return null;
  }

  for (const node of nodes) {
    if (color.get(node.id) === WHITE) {
      const cycleError = dfs(node.id, [node.id]);
      if (cycleError) {
        return { valid: false, error: cycleError };
      }
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Return tasks grouped into execution tiers using Kahn's algorithm:
 *
 * - **Tier 0**: Tasks with no dependencies (can run in parallel).
 * - **Tier 1**: Tasks depending only on Tier 0 (run after Tier 0 completes).
 * - ...and so on.
 *
 * Throws if the graph contains a cycle (caller should validate first).
 * Returns `[]` for an empty node list.
 */
export function topologicalSort(nodes: DAGNode[]): string[][] {
  if (nodes.length === 0) {
    return [];
  }

  // Build in-degree map and adjacency list (dependency → dependents)
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → list of nodes that depend on it

  for (const node of nodes) {
    if (!inDegree.has(node.id)) {
      inDegree.set(node.id, 0);
    }
    if (!dependents.has(node.id)) {
      dependents.set(node.id, []);
    }
    for (const dep of node.dependsOn) {
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      if (!dependents.has(dep)) {
        dependents.set(dep, []);
      }
      dependents.get(dep)!.push(node.id);
    }
  }

  // Build an index map to preserve input order within each tier.
  // This ensures that when max_workers === 1, tasks run in the order
  // they were provided (by the caller's Task.order / plan order).
  const inputOrder = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    inputOrder.set(nodes[i].id, i);
  }

  const tiers: string[][] = [];
  let remaining = nodes.length;

  // Seed with all zero in-degree nodes, preserving original input order
  let currentTier = nodes
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);

  while (currentTier.length > 0) {
    // Preserve the order in which tasks were provided to maintain determinism
    currentTier.sort((a, b) => (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0));
    tiers.push(currentTier);
    remaining -= currentTier.length;

    const nextTier: string[] = [];
    for (const nodeId of currentTier) {
      for (const dependent of dependents.get(nodeId) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          nextTier.push(dependent);
        }
      }
    }
    currentTier = nextTier;
  }

  if (remaining > 0) {
    throw new Error("Cycle detected: topological sort could not process all nodes");
  }

  return tiers;
}

// ---------------------------------------------------------------------------
// Executable task resolution
// ---------------------------------------------------------------------------

/**
 * Given the set of completed and failed task IDs, determine which remaining
 * tasks can run, which are blocked, and which should be skipped.
 *
 * - **executable**: All dependencies are in `completed`.
 * - **skipped**: At least one dependency is in `failed` (task can never run).
 * - **blocked**: Has unfinished dependencies that haven't failed.
 */
export function getExecutableTasks(
  nodes: DAGNode[],
  completed: Set<string>,
  failed: Set<string>,
): ExecutableTasksResult {
  const executable: string[] = [];
  const blocked: string[] = [];
  const skipped: string[] = [];

  // We need to transitively propagate failure: if A failed and B depends on A,
  // then C depending on B should also be skipped.
  const effectivelyFailed = new Set(failed);

  // Iteratively propagate failure through the graph
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (completed.has(node.id) || effectivelyFailed.has(node.id)) continue;
      for (const dep of node.dependsOn) {
        if (effectivelyFailed.has(dep)) {
          effectivelyFailed.add(node.id);
          changed = true;
          break;
        }
      }
    }
  }

  for (const node of nodes) {
    // Skip nodes that are already done or failed
    if (completed.has(node.id) || failed.has(node.id)) {
      continue;
    }

    if (effectivelyFailed.has(node.id)) {
      skipped.push(node.id);
      continue;
    }

    // Check if all dependencies are completed
    const allDepsCompleted = node.dependsOn.every((dep) => completed.has(dep));
    if (allDepsCompleted) {
      executable.push(node.id);
    } else {
      blocked.push(node.id);
    }
  }

  // Sort for deterministic output
  executable.sort();
  blocked.sort();
  skipped.sort();

  return { executable, blocked, skipped };
}

// ---------------------------------------------------------------------------
// Serialization constraints
// ---------------------------------------------------------------------------

/**
 * Inject synthetic dependencies into a DAG to serialize tasks that would
 * concurrently modify conflict-prone files.
 *
 * For each pair of tasks in the same topological tier that both declare a
 * `serializedFiles` entry matching the same constraint pattern, the second
 * task (by input order) gains a dependency on the first. This ensures they
 * execute sequentially rather than in parallel.
 *
 * Returns a new array of DAGNodes with the injected dependencies. The
 * original nodes are not mutated.
 */
export function applySerializationConstraints(
  nodes: DAGNode[],
  constraintPatterns: string[],
): DAGNode[] {
  if (constraintPatterns.length === 0) return nodes;

  // Clone nodes so we don't mutate the input
  const result: DAGNode[] = nodes.map((n) => ({
    ...n,
    dependsOn: [...n.dependsOn],
    serializedFiles: n.serializedFiles ? [...n.serializedFiles] : undefined,
  }));

  // Build a lookup from ID to index for efficient access
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    idToIndex.set(result[i].id, i);
  }

  // Helper: compute the topological depth of a node (longest chain of
  // dependencies). Nodes with no dependencies have depth 0.  Used to sort
  // matching IDs before chaining so that we never inject an edge from a
  // deeper node to a shallower one (which would create a cycle).
  const depthMemo = new Map<string, number>();
  const depthOf = (id: string, ancestors: Set<string> = new Set()): number => {
    if (ancestors.has(id)) return 0; // cycle guard
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    ancestors.add(id);
    const nodeIdx = idToIndex.get(id);
    if (nodeIdx === undefined) return 0;
    const node = result[nodeIdx];
    if (node.dependsOn.length === 0) return 0;
    const depth = 1 + Math.max(...node.dependsOn.map(dep => depthOf(dep, new Set(ancestors))));
    depthMemo.set(id, depth);
    return depth;
  };

  // For each constraint pattern, find all tasks that touch a matching file
  // and chain them so they execute serially (ordered by topological depth
  // to prevent cycle creation).
  for (const pattern of constraintPatterns) {
    // Collect task IDs that match this pattern
    const matchingIds: string[] = [];

    for (const node of result) {
      if (!node.serializedFiles || node.serializedFiles.length === 0) continue;
      const touchesConstrained = node.serializedFiles.some((f) => matchesGlob(f, pattern));
      if (touchesConstrained) {
        matchingIds.push(node.id);
      }
    }

    // If fewer than 2 tasks match, no serialization needed for this pattern
    if (matchingIds.length < 2) continue;

    // Sort by topological depth so we always chain shallow → deep,
    // preventing cycles when tasks arrive in arbitrary order.
    matchingIds.sort((a, b) => depthOf(a) - depthOf(b));

    // Chain: task[1] depends on task[0], task[2] depends on task[1], etc.
    for (let i = 1; i < matchingIds.length; i++) {
      const currentIdx = idToIndex.get(matchingIds[i])!;
      const prevId = matchingIds[i - 1];
      if (!result[currentIdx].dependsOn.includes(prevId)) {
        result[currentIdx].dependsOn.push(prevId);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Shared-file constraints
// ---------------------------------------------------------------------------

/**
 * Inject synthetic dependencies to serialize tasks that declare the same
 * file in their `serializedFiles` arrays — even when no explicit constraint
 * pattern matches that file.
 *
 * This complements `applySerializationConstraints` (which uses glob patterns
 * from config) by catching ad-hoc overlaps: if task A and task B both list
 * `"src/lib/jwt.ts"` in serializedFiles, they must not run in parallel or
 * they will produce merge conflicts.
 *
 * Chaining order follows topological depth (shallow → deep) to avoid
 * introducing cycles, consistent with `applySerializationConstraints`.
 *
 * Returns a new array of DAGNodes with injected dependencies. The original
 * nodes are not mutated.
 */
export function applySharedFileConstraints(nodes: DAGNode[]): DAGNode[] {
  // Quick exit: if fewer than 2 nodes have serializedFiles, no overlap is possible
  const nodesWithFiles = nodes.filter(
    (n) => n.serializedFiles && n.serializedFiles.length > 0,
  );
  if (nodesWithFiles.length < 2) return nodes;

  // Clone nodes so we don't mutate the input
  const result: DAGNode[] = nodes.map((n) => ({
    ...n,
    dependsOn: [...n.dependsOn],
    serializedFiles: n.serializedFiles ? [...n.serializedFiles] : undefined,
  }));

  // Build a lookup from ID to index
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    idToIndex.set(result[i].id, i);
  }

  // Build a map from file path → deduplicated list of task IDs that declare it.
  // A task may list the same file twice; we deduplicate to prevent self-dependencies.
  const fileToTaskIds = new Map<string, string[]>();
  for (const node of result) {
    if (!node.serializedFiles) continue;
    for (const file of node.serializedFiles) {
      let list = fileToTaskIds.get(file);
      if (!list) {
        list = [];
        fileToTaskIds.set(file, list);
      }
      if (!list.includes(node.id)) {
        list.push(node.id);
      }
    }
  }

  // Helper: compute topological depth (same logic as applySerializationConstraints)
  const depthMemo = new Map<string, number>();
  const depthOf = (id: string, ancestors: Set<string> = new Set()): number => {
    if (ancestors.has(id)) return 0; // cycle guard
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    ancestors.add(id);
    const nodeIdx = idToIndex.get(id);
    if (nodeIdx === undefined) return 0;
    const node = result[nodeIdx];
    if (node.dependsOn.length === 0) return 0;
    const depth =
      1 + Math.max(...node.dependsOn.map((dep) => depthOf(dep, new Set(ancestors))));
    depthMemo.set(id, depth);
    return depth;
  };

  // For each shared file, chain the tasks that declare it
  for (const [, taskIds] of fileToTaskIds) {
    if (taskIds.length < 2) continue;

    // Sort by topological depth to prevent cycles
    taskIds.sort((a, b) => depthOf(a) - depthOf(b));

    // Chain: task[1] depends on task[0], task[2] depends on task[1], etc.
    for (let i = 1; i < taskIds.length; i++) {
      const currentIdx = idToIndex.get(taskIds[i])!;
      const prevId = taskIds[i - 1];
      if (!result[currentIdx].dependsOn.includes(prevId)) {
        result[currentIdx].dependsOn.push(prevId);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Create → Modify dependency inference
// ---------------------------------------------------------------------------

/**
 * If task A declares it will **create** file X and task B declares it will
 * **modify** file X, then B must run after A — B can't modify a file that
 * doesn't exist yet.
 *
 * This injects `A → B` dependency edges for every such pair.
 * Returns a new array of DAGNodes with injected dependencies.
 */
export function applyCreateModifyConstraints(nodes: DAGNode[]): DAGNode[] {
  // Build map: file → all creator task IDs
  const fileCreators = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.createsFiles) continue;
    for (const file of node.createsFiles) {
      let creators = fileCreators.get(file);
      if (!creators) {
        creators = [];
        fileCreators.set(file, creators);
      }
      if (!creators.includes(node.id)) {
        creators.push(node.id);
      }
    }
  }

  if (fileCreators.size === 0) return nodes;

  // Clone nodes
  const result: DAGNode[] = nodes.map((n) => ({
    ...n,
    dependsOn: [...n.dependsOn],
    serializedFiles: n.serializedFiles ? [...n.serializedFiles] : undefined,
    createsFiles: n.createsFiles ? [...n.createsFiles] : undefined,
  }));

  // For each node that modifies a file, add deps on ALL creators of that file
  for (const node of result) {
    if (!node.serializedFiles) continue;
    for (const file of node.serializedFiles) {
      const creatorIds = fileCreators.get(file);
      if (!creatorIds) continue;
      for (const creatorId of creatorIds) {
        if (creatorId !== node.id && !node.dependsOn.includes(creatorId)) {
          node.dependsOn.push(creatorId);
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dynamic edge injection (runtime replanning)
// ---------------------------------------------------------------------------

/**
 * Inject dynamic dependency edges into a DAG at runtime. Follows the
 * immutable pattern — clones nodes, adds edges, returns new array.
 *
 * Edges are specified as `{ from, to }` where `to` now depends on `from`.
 * Skips edges that already exist or reference non-existent nodes.
 */
export function injectDynamicEdges(
  nodes: DAGNode[],
  edges: Array<{ from: string; to: string }>,
): DAGNode[] {
  const idSet = new Set(nodes.map((n) => n.id));

  const result: DAGNode[] = nodes.map((n) => ({
    ...n,
    dependsOn: [...n.dependsOn],
    serializedFiles: n.serializedFiles ? [...n.serializedFiles] : undefined,
    createsFiles: n.createsFiles ? [...n.createsFiles] : undefined,
  }));

  const idToIndex = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    idToIndex.set(result[i].id, i);
  }

  for (const edge of edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    const toIdx = idToIndex.get(edge.to)!;
    if (!result[toIdx].dependsOn.includes(edge.from)) {
      result[toIdx].dependsOn.push(edge.from);
    }
  }

  return result;
}

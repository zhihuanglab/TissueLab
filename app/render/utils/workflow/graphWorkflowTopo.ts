/**
 * Topological ordering of model nodes using workflow graph edges.
 * Edge from A → B means B runs after A (B depends on A).
 */

export type TopoModelNode = { id: string; y: number; backendName: string };

export type TopoConnection = { fromId: string; toId: string };

/**
 * Returns model node ids that are outside the first connected model component.
 * Graph "Run all" is a single workflow run, so multiple disconnected model
 * islands should be rejected instead of sent as unrelated scheduler roots.
 */
export function disconnectedModelNodeIds(
  modelNodes: { id: string }[],
  connections: TopoConnection[]
): string[] {
  if (modelNodes.length <= 1) return [];

  const modelIds = new Set(modelNodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const id of modelIds) {
    adj.set(id, new Set());
  }

  for (const c of connections) {
    if (!modelIds.has(c.fromId) || !modelIds.has(c.toId)) continue;
    adj.get(c.fromId)?.add(c.toId);
    adj.get(c.toId)?.add(c.fromId);
  }

  const start = modelNodes[0].id;
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adj.get(id) || []) {
      if (!seen.has(next)) stack.push(next);
    }
  }

  return modelNodes.map((n) => n.id).filter((id) => !seen.has(id));
}

/**
 * For "Run Workflow", every model node must be part of a directed path from
 * Start to End. A loose node (even a single one) can be run via "Run stage",
 * but should not be submitted as a full workflow.
 */
export function modelNodeIdsOutsideStartEndPath(
  modelNodes: { id: string }[],
  connections: TopoConnection[],
  startId: string,
  endId: string
): string[] {
  if (modelNodes.length === 0) return [];

  const ids = new Set<string>([startId, endId, ...modelNodes.map((n) => n.id)]);
  const adj = new Map<string, Set<string>>();
  const rev = new Map<string, Set<string>>();
  for (const id of ids) {
    adj.set(id, new Set());
    rev.set(id, new Set());
  }

  for (const c of connections) {
    if (!ids.has(c.fromId) || !ids.has(c.toId)) continue;
    adj.get(c.fromId)?.add(c.toId);
    rev.get(c.toId)?.add(c.fromId);
  }

  const walk = (root: string, graph: Map<string, Set<string>>) => {
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of graph.get(id) || []) {
        if (!seen.has(next)) stack.push(next);
      }
    }
    return seen;
  };

  const reachableFromStart = walk(startId, adj);
  const canReachEnd = walk(endId, rev);

  return modelNodes
    .map((n) => n.id)
    .filter((id) => !reachableFromStart.has(id) || !canReachEnd.has(id));
}

/**
 * Kahn topological sort with stable tie-break: lower y first, then id.
 * Returns null if a cycle is detected or a model node has no backend name.
 */
export function topoSortModelNodesForRun(
  modelNodes: TopoModelNode[],
  connections: TopoConnection[]
): TopoModelNode[] | null {
  if (modelNodes.length === 0) return [];
  const byId = new Map(modelNodes.map((n) => [n.id, n]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const n of modelNodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }

  for (const c of connections) {
    if (!byId.has(c.fromId) || !byId.has(c.toId)) continue;
    indeg.set(c.toId, (indeg.get(c.toId) ?? 0) + 1);
    adj.get(c.fromId)!.push(c.toId);
  }

  const cmp = (a: TopoModelNode, b: TopoModelNode) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.id.localeCompare(b.id);
  };

  const q = modelNodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).sort(cmp);
  const out: TopoModelNode[] = [];
  const seen = new Set<string>();

  while (q.length > 0) {
    const n = q.shift()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    for (const v of adj.get(n.id) || []) {
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if (indeg.get(v) === 0) {
        const node = byId.get(v);
        if (node) {
          q.push(node);
          q.sort(cmp);
        }
      }
    }
  }

  if (out.length !== modelNodes.length) {
    return null;
  }
  return out;
}

/**
 * Build task_dependencies map: backend node name -> list of dependency backend names.
 * Multiple graph nodes mapping to the same backend name merge dependencies (union).
 */
export function buildTaskDependenciesFromTopo(
  ordered: TopoModelNode[],
  connections: TopoConnection[],
  idToBackend: Map<string, string>
): Record<string, string[]> {
  const depsByBackend = new Map<string, Set<string>>();

  const ensure = (name: string) => {
    if (!depsByBackend.has(name)) depsByBackend.set(name, new Set());
  };

  for (const n of ordered) {
    ensure(idToBackend.get(n.id)!);
  }

  for (const c of connections) {
    const fromB = idToBackend.get(c.fromId);
    const toB = idToBackend.get(c.toId);
    if (!fromB || !toB || fromB === toB) continue;
    ensure(toB);
    depsByBackend.get(toB)!.add(fromB);
  }

  for (const n of ordered) {
    const b = idToBackend.get(n.id);
    if (!b) continue;
    ensure(b);
  }

  const result: Record<string, string[]> = {};
  for (const [node, set] of depsByBackend) {
    result[node] = Array.from(set);
  }
  return result;
}

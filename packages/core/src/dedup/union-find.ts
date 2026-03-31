/**
 * Directed union-find with iterative path compression.
 *
 * Given a list of (source, target) UUID pairs representing alias→canonical
 * mappings, collapses transitive chains so every UUID resolves to its ultimate
 * canonical target.
 *
 * Example: [(a,b), (b,c)] → {a:c, b:c, c:c}
 */
export function buildDirectedUuidMap(pairs: [string, string][]): Map<string, string> {
  const parent = new Map<string, string>();

  function find(uuid: string): string {
    if (!parent.has(uuid)) parent.set(uuid, uuid);

    let root = uuid;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }

    // Path compression
    let current = uuid;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }

    return root;
  }

  for (const [source, target] of pairs) {
    if (!parent.has(source)) parent.set(source, source);
    if (!parent.has(target)) parent.set(target, target);
    parent.set(find(source), find(target));
  }

  const result = new Map<string, string>();
  for (const uuid of parent.keys()) {
    result.set(uuid, find(uuid));
  }

  return result;
}

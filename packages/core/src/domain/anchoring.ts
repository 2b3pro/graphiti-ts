import type { EntityEdge } from './edges';

export const ANCHOR_TYPES = [
  'scale', 'definition', 'baseline', 'comparison',
  'taxonomy', 'temporal_frame', 'scope', 'methodology',
] as const;

export type AnchorType = (typeof ANCHOR_TYPES)[number];

export interface AnchoredInterpretation {
  anchor_uuid: string;
  anchor_type: AnchorType;
  derived_meaning?: string | null;
  derived_weight?: number | null;
  computed_at: Date;
}

export interface AnchorGraphContext {
  getEdge(uuid: string): EntityEdge | null;
}

export function computeAnchorConfidence(
  edge: EntityEdge,
  ctx: AnchorGraphContext,
  visited: Set<string> = new Set()
): number {
  if (!edge.anchored_by?.length) return 1.0;
  if (visited.has(edge.uuid)) return 0.0;
  visited.add(edge.uuid);

  const anchorConfidences = edge.anchored_by.map((uuid) => {
    const anchor = ctx.getEdge(uuid);
    if (!anchor) return 0.0;
    if (anchor.invalid_at) return 0.0;
    // Copy visited set per branch to avoid corrupting sibling evaluations
    // in diamond-shaped anchor graphs (A→B, A→C, B→C)
    const branchVisited = new Set(visited);
    const anchorChainConf = computeAnchorConfidence(anchor, ctx, branchVisited);
    const anchorOwnConf = anchor.confidence?.[1] ?? 1.0;
    return anchorChainConf * anchorOwnConf;
  });

  return Math.max(...anchorConfidences);
}

/**
 * Maintenance module — port of Python's utils/maintenance/ package.
 *
 * Provides the core LLM-driven extraction, resolution, and deduplication
 * pipeline for the Graphiti knowledge graph.
 */

export {
  extractNodes,
  resolveExtractedNodes,
  extractAttributesFromNodes,
  buildEntityTypesContext,
  type EntityTypeDefinition
} from './node-operations';

export {
  extractEdges,
  resolveExtractedEdges,
  resolveExtractedEdge,
  buildEpisodicEdges,
  resolveEdgePointers,
  type EdgeTypeDefinition
} from './edge-operations';

export {
  addNodesAndEdgesBulk,
  extractNodesAndEdgesBulk,
  dedupeNodesBulk,
  dedupeEdgesBulk,
  type RawEpisode
} from './bulk-utils';

export {
  detectNegation,
  HIGH_CONFIDENCE_NEGATION,
  MEDIUM_CONFIDENCE_NEGATION,
  type NegationSignal,
} from './negation';

import type { EpisodeType } from './domain/nodes';
import type { DeprecationGateConfig } from './domain/deprecation-gate';

export type CommunityDetectionStrategy = 'auto' | 'gds' | 'label_propagation';

export interface GraphitiExtractionConfig {
  default_instructions_by_episode_source?: Partial<Record<EpisodeType, string>>;
}

export interface GraphitiCommunityConfig {
  detection_strategy?: CommunityDetectionStrategy;
  max_members_per_summary?: number;
  batch_size?: number;
}

export interface GraphitiBulkIngestConfig {
  prefer_batch_embeddings?: boolean;
}

export interface GraphitiResolutionConfig {
  pre_filter_enabled?: boolean;
  node_similarity_threshold?: number;
  edge_similarity_threshold?: number;
  margin_threshold?: number;
  log_decisions?: boolean;
  /** File path for JSONL decision log. When set, resolution decisions are appended here instead of console.info. */
  log_destination?: string;
}

export interface GraphitiLifecycleConfig {
  deprecation_gate?: DeprecationGateConfig;
}

/**
 * Per-prompt model routing. Keys are prompt names (e.g., 'dedupe_nodes.nodes')
 * or glob-style prefixes (e.g., 'extract_nodes.*'). Values are model identifiers
 * passed as model_override to generateText().
 *
 * Resolution order: exact prompt_name match → prefix match → model_size fallback → client.model.
 *
 * Known prompt names:
 *   extract_nodes.text / extract_nodes.message / extract_nodes.json  — entity extraction
 *   extract_edges.edge                                                — relationship extraction
 *   dedupe_nodes.nodes                                                — entity dedup/resolution
 *   dedupe_edges.resolve_edge                                         — edge contradiction/dedup
 *   extract_nodes.extract_attributes                                  — node attribute hydration
 *   extract_nodes.extract_summaries_batch                             — batch node summarization
 *   extract_edges.extract_attributes                                  — edge field extraction
 */
export interface GraphitiModelRoutingConfig {
  [promptNameOrPrefix: string]: string;
}

export interface GraphitiConfig {
  extraction: GraphitiExtractionConfig;
  community: GraphitiCommunityConfig;
  bulk_ingest: GraphitiBulkIngestConfig;
  resolution: GraphitiResolutionConfig;
  lifecycle: GraphitiLifecycleConfig;
  model_routing: GraphitiModelRoutingConfig;
}

export interface GraphitiConfigOverrides {
  extraction?: GraphitiExtractionConfig;
  community?: GraphitiCommunityConfig;
  bulk_ingest?: GraphitiBulkIngestConfig;
  resolution?: GraphitiResolutionConfig;
  lifecycle?: GraphitiLifecycleConfig;
  model_routing?: GraphitiModelRoutingConfig;
}

/**
 * Resolve the model to use for a given prompt name using the routing config.
 * Resolution order: exact match → prefix match (longest wins) → null (use caller default).
 */
export function resolveModelForPrompt(
  routing: GraphitiModelRoutingConfig | undefined,
  promptName: string | null | undefined,
): string | null {
  if (!routing || !promptName) return null;

  // Exact match
  if (routing[promptName]) return routing[promptName];

  // Prefix match — find longest matching prefix (e.g., 'extract_nodes.*' matches 'extract_nodes.text')
  let bestMatch: string | null = null;
  let bestLen = 0;
  for (const key of Object.keys(routing)) {
    if (key.endsWith('.*')) {
      const prefix = key.slice(0, -2);
      if (promptName.startsWith(prefix) && prefix.length > bestLen) {
        bestMatch = routing[key]!;
        bestLen = prefix.length;
      }
    }
  }

  return bestMatch;
}

export const DEFAULT_GRAPHITI_CONFIG: GraphitiConfig = {
  extraction: {
    default_instructions_by_episode_source: {}
  },
  community: {
    detection_strategy: 'auto'
  },
  bulk_ingest: {
    prefer_batch_embeddings: true
  },
  resolution: {
    pre_filter_enabled: false,
    node_similarity_threshold: 0.7,
    edge_similarity_threshold: 0.65,
    margin_threshold: 0.05,
    log_decisions: false
  },
  lifecycle: {},
  model_routing: {}
};

/**
 * Log a resolution decision. Routes to file (JSONL append) when log_destination is set,
 * otherwise falls back to console.info for interceptor-based capture.
 */
export function logResolutionDecision(
  config: GraphitiResolutionConfig,
  prefix: string,
  data: Record<string, unknown>,
): void {
  if (!config.log_decisions) return;

  const line = JSON.stringify(data);

  if (config.log_destination) {
    try {
      const { appendFileSync } = require('fs');
      appendFileSync(config.log_destination, `${prefix} ${line}\n`);
    } catch {
      // Fall back to console if file write fails
      console.info(prefix, line);
    }
  } else {
    console.info(prefix, line);
  }
}

export function createGraphitiConfig(
  overrides: GraphitiConfigOverrides = {}
): GraphitiConfig {
  return {
    extraction: {
      ...DEFAULT_GRAPHITI_CONFIG.extraction,
      ...overrides.extraction,
      default_instructions_by_episode_source: {
        ...DEFAULT_GRAPHITI_CONFIG.extraction.default_instructions_by_episode_source,
        ...overrides.extraction?.default_instructions_by_episode_source
      }
    },
    community: {
      ...DEFAULT_GRAPHITI_CONFIG.community,
      ...overrides.community
    },
    bulk_ingest: {
      ...DEFAULT_GRAPHITI_CONFIG.bulk_ingest,
      ...overrides.bulk_ingest
    },
    resolution: {
      ...DEFAULT_GRAPHITI_CONFIG.resolution,
      ...overrides.resolution
    },
    lifecycle: {
      ...DEFAULT_GRAPHITI_CONFIG.lifecycle,
      ...overrides.lifecycle
    },
    model_routing: {
      ...DEFAULT_GRAPHITI_CONFIG.model_routing,
      ...overrides.model_routing
    }
  };
}

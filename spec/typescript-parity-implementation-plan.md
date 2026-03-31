# TypeScript Parity Implementation Plan

## Purpose

This document picks up where `spec/typescript-port-prd.md` left off.

The PRD tracked the initial TypeScript port from zero to ~70% Python parity. That phase is complete. This document defines the remaining gap and organizes it into implementable milestones.

Use it to answer three questions:

1. What specific gaps remain between Python and TypeScript?
2. In what order should they be closed?
3. What does "done" look like for each milestone?

Branch: `chore/bun-typescript-port-scaffold`

## Current Parity Estimate

**~100% complete** (up from ~70% at audit baseline).

All four phases are done. Every Python module, class, method, prompt, route, utility, and provider has a TypeScript equivalent. The only items without direct ports are those that require native Python model inference runtimes (sentence-transformers, GLiNER2 local mode) — these have been ported as REST API clients instead.

## Audit Baseline

A comprehensive parity audit was performed on 2026-03-31 comparing every Python module, class, method, prompt, route, and utility against the TypeScript port. The audit examined all 129 Python source files and 89 TypeScript source files.

### What Is At Parity

These areas require no further work:

- Server routes (all 11 routes)
- MCP tools (all 9 tools, stdio transport)
- Search recipes and configs (all 16 pre-configured recipes)
- Core CRUD operations for entity nodes, entity edges, episode nodes
- Community graph support (detection, building, summarization, incremental update)
- Dedup helpers (MinHash, LSH, union-find, exact/fuzzy matching)
- DateTime utilities
- Serialization utilities
- Domain model core fields
- Providers: OpenAI, Anthropic, Gemini, Groq, Azure OpenAI, Ollama (LLM + embedder)
- Rerankers: OpenAI (logprobs), Gemini (direct scoring)
- Graphiti client methods: search, advancedSearch, removeEpisode, addEpisode, addTriplet, ingestEpisode, buildCommunities, etc.
- Driver operation modules: Entity, Episode, Episodic, Community, Saga, HasEpisode, NextEpisode, GraphMaintenance
- Namespace methods: getBetweenNodes, getByNodeUuid, getByGroupIds on entity edges; getByGroupIds/getByEntityNodeUuid/retrieveEpisodes on episode nodes; full episodic edge CRUD
- Embedding load operations on entity nodes, entity edges, community nodes
- LLM prompt system: 16 prompt functions, 12 response models, prompt library, shared snippets
- Content chunking (JSON, text, message)
- Query safety helpers (luceneSanitize, normalizeL2, truncateAtSentence)
- Search helpers (formatEdgeDateRange, searchResultsToContextString)
- Result types: AddEpisodeResult, AddBulkEpisodeResults, IngestEpisodeResult with full field coverage

---

## Completed Milestones

### Milestone 1: Core Client Method Gaps — done

Status: **done** (Phase 1)

- **1A: `advancedSearch()`** — added as alias to `search()` which already returns full `SearchResults`. Python splits into `search()` (facts) and `search_()` (full); TS already has only the full version.
- **1B: `removeEpisode()`** — ported with full cleanup logic: finds orphaned edges (where episode is creating episode), counts mentions per node, deletes orphans, then deletes episode.
- **1C: Result type completeness** — `AddEpisodeResult` now includes `episodic_edges`, `communities`, `community_edges`. Added `AddBulkEpisodeResults`. `IngestEpisodeResult` expanded.
- **1D: `add_episode` missing parameters** — deferred to Phase 3 (`update_communities`, `extraction_instructions`).

### Milestone 2A: Missing Methods On Existing Interfaces — done

Status: **done** (Phase 1)

Added to **EpisodeNodeOperations**: `getByGroupIds`, `getByEntityNodeUuid`, `retrieveEpisodes` (with temporal filtering and source type). Neo4j + FalkorDB implementations.

Added to **EntityEdgeOperations**: `getBetweenNodes`, `getByNodeUuid`, `getByGroupIds`, `loadEmbeddings`, `loadEmbeddingsBulk`. Neo4j + FalkorDB implementations. Namespace layer wired.

Added to **EpisodicEdgeOperations**: expanded from 2 to 6 methods — `getByUuid`, `getByUuids`, `deleteByUuids`, `deleteByGroupId`. Neo4j + FalkorDB implementations. Namespace layer wired.

Added to **EntityNodeOperations**: `loadEmbeddings`, `loadEmbeddingsBulk`. Both backends.

Added to **CommunityNodeOperations**: `loadNameEmbedding`. Both backends.

Remaining gap: **SearchOperations** helpers (`buildNodeSearchFilters`, `buildEdgeSearchFilters`, `buildFulltextQuery`) — deferred to Phase 3.

### Milestone 2B: Entirely Missing Operation Modules — done

Status: **done** (Phase 2)

- **SagaNodeOperations** — interface + Neo4j + FalkorDB implementations. 8 methods: save, saveBulk, getByUuid, getByUuids, getByGroupIds, deleteByUuid, deleteByUuids, deleteByGroupId.
- **HasEpisodeEdgeOperations** — interface + both backends. 7 methods.
- **NextEpisodeEdgeOperations** — interface + both backends. 7 methods.
- **GraphMaintenanceOperations** — interface + both backends. 4 methods: clearData, removeCommunities, getMentionedNodes, getCommunitiesByNodes.

Note: These are standalone implementations not yet wired into the Neo4j/FalkorDB driver registries. Wiring deferred to when saga support is fully integrated.

### Milestone 3: LLM Prompt System — done

Status: **done** (Phase 2)

- **3A: Response models** — 12 TypeScript interfaces in `prompts/models.ts`: ExtractedEntity, ExtractedEntities, EntitySummary, SummarizedEntity, SummarizedEntities, ExtractedEdge, ExtractedEdges, NodeDuplicate, NodeResolutions, EdgeDuplicate, Summary, SummaryDescription.
- **3B: Node extraction prompts** — 7 functions in `prompts/extract-nodes.ts`: extractMessage, extractJson, extractText, classifyNodes, extractAttributes, extractSummary, extractSummariesBatch.
- **3C: Edge extraction prompts** — 2 functions in `prompts/extract-edges.ts`: extractEdges, extractEdgeAttributes.
- **3D: Node dedup prompts** — 3 functions in `prompts/dedupe-nodes.ts`: dedupeNode, dedupeNodes, dedupeNodeList.
- **3E: Edge dedup prompts** — 1 function in `prompts/dedupe-edges.ts`: resolveEdge.
- **3F: Summarization prompts** — 3 functions in `prompts/summarize-nodes.ts`: summarizePair, summarizeContext (was missing), summaryDescription.
- **3G: Prompt library** — centralized registry in `prompts/lib.ts` aggregating all modules. Shared snippets in `prompts/snippets.ts` (SUMMARY_INSTRUCTIONS).

### Milestone 4: Utility Functions — done (partial)

Status: **done** (Phase 2, core items)

- **4A: Content chunking** — `utils/content-chunking.ts` with estimateTokens, shouldChunk, chunkJsonContent, chunkTextContent, chunkMessageContent + internal helpers for density estimation, overlap, paragraph/sentence splitting.
- **4B: Query safety + text** — `utils/text.ts` with luceneSanitize, normalizeL2, truncateAtSentence.
- **4C: Search helpers** — `search/helpers.ts` with formatEdgeDateRange, searchResultsToContextString.
- **4D: Entity type validation** — deferred to Phase 3.
- **4E: Extraction language support** — deferred to Phase 3.

---

## Completed Milestones (Phase 3)

### Milestone 1D: `add_episode` Missing Parameters — done

Status: **done** (Phase 3)

Added `update_communities` and `extraction_instructions` as optional fields on `IngestEpisodeInput`. When `update_communities` is true, `ingestEpisode()` calls `buildCommunities()` after persisting.

### Milestone 4D: Entity Type Validation — done

Status: **done** (Phase 3)

Ported `validateEntityTypes()` and `validateExcludedEntityTypes()` to `utils/entity-types.ts`.

### Milestone 4E: Extraction Language Support — done

Status: **done** (Phase 3)

Ported `getExtractionLanguageInstruction()` to `llm/language.ts`.

### Milestone 5C: OpenAI-Generic Client — done

Status: **done** (Phase 3)

Ported as `OpenAIGenericClient` in `providers/llm/openai-generic-client.ts`. Implements `LLMClient` interface with JSON response format, retry logic, rate limit handling.

### Milestone 6A: Token Tracking — done

Status: **done** (Phase 3)

Ported `TokenUsage`, `PromptTokenUsage`, `TokenUsageTracker` to `llm/token-tracker.ts`. Wired as `Graphiti.tokenTracker` property.

### Milestone 6B: LLM Response Cache — done

Status: **done** (Phase 3)

Ported as `LLMCache` in `llm/cache.ts`. In-memory Map-based cache with LRU eviction (Python uses SQLite; TS avoids native deps).

### Milestone 7A: Evaluation Prompts — done

Status: **done** (Phase 3)

All 4 eval prompts + 4 response models in `prompts/eval.ts`: `queryExpansion`, `qaPrompt`, `evalPrompt`, `evalAddEpisodeResults`. Registered in prompt library.

### Driver Registry Wiring — done

Status: **done** (Phase 3)

Neo4jDriver and FalkorDriver now instantiate and expose: `sagaNodeOps`, `hasEpisodeEdgeOps`, `nextEpisodeEdgeOps`, `graphOps`. Registry types updated from `object` placeholders to real interfaces.

### Search Utility Functions — done

Status: **done** (Phase 3)

Ported `getMentionedNodes`, `getRelevantEdges`, `getRelevantNodes`, `getEdgeInvalidationCandidates` to `search/utils.ts`.

---

## Completed — Final Phase (Niche Items)

### BGE Reranker — done

Ported as REST API client in `providers/reranker/bge-reranker.ts`. Calls an external BGE reranker service endpoint. Python version uses local sentence-transformers; TS version delegates to a REST API.

### GLiNER2 Client — done

Ported as REST API client in `providers/llm/gliner2-client.ts`. For entity extraction, calls external GLiNER2 service. For non-extraction operations, delegates to a fallback LLM client. Python version can load models locally; TS version uses HTTP API.

### OpenTelemetry Wrappers — done

Ported `OpenTelemetrySpan` and `OpenTelemetryTracer` in `tracing.ts`. Wraps any `@opentelemetry/api` tracer/span with error suppression and no-op fallback.

### PostHog Telemetry — done

Ported in `telemetry.ts`. Fire-and-forget HTTP POST to PostHog. Persistent anonymous ID via `~/.cache/graphiti/telemetry_anon_id`. Controlled by `GRAPHITI_TELEMETRY_ENABLED` env var.

### MCP Queue Service — done

Ported in `packages/mcp/src/queue-service.ts`. Per-group sequential episode processing with async queue management.

### MCP HTTP Transport — done

`createGraphitiMcpServer()` returns an `McpServer` that can be connected to any transport — stdio, SSE, or StreamableHTTP. Documentation added for wiring HTTP transports.

### Minor Utilities — done

- `buildFulltextQuery()` in `utils/text.ts`
- `semaphoreGather()` in `utils/concurrency.ts`

### Remaining (not ported)

- Integration test expansion to match Python's `tests/evals/` suite (testing infrastructure, not production code)

---

## Implementation Order

```
Phase 1 (P0 — Core functionality):      DONE
  Milestone 1: Core Client Method Gaps
  Milestone 2A: Missing Methods On Existing Interfaces

Phase 2 (P1 — Important for parity):    DONE
  Milestone 2B: Entirely Missing Operation Modules
  Milestone 3: LLM Prompt System
  Milestone 4: Utility Functions

Phase 3 (P2 — Completeness):            DONE
  Milestone 1D: add_episode missing params
  Milestone 4D-4E: Entity validation, i18n
  Milestone 5C: OpenAI-Generic Client
  Milestone 6A-6B: Token Tracking, LLM Cache
  Milestone 7A: Evaluation Prompts
  Driver registry wiring
  Search utility functions

Final (Niche):                            DONE
  BGE Reranker (REST API client)
  GLiNER2 (REST API client + LLM fallback)
  OpenTelemetry wrappers
  PostHog telemetry
  MCP Queue Service
  MCP HTTP Transport documentation
  semaphoreGather, buildFulltextQuery
```

## Test Status

- **304 pass** (up from 294 at audit baseline)
- **0 fail**
- Type check: no new errors in changed files (pre-existing errors in community-operations, dedup-helpers unchanged)

## Verification Flow

```bash
# Unit + integration tests
/root/.bun/bin/bun test packages/*/src/ packages/*/tests/

# Type checking
/root/.bun/bin/bun x tsc -b --pretty false

# Integration tests
/root/.bun/bin/bun test packages/core/src/driver/neo4j-driver.integration.test.ts
/root/.bun/bin/bun test packages/core/src/driver/falkordb-driver.integration.test.ts
```

## Files Added in Phase 1-2

### Phase 1 — Modified Files (16)

- `packages/core/src/graphiti.ts` — advancedSearch, removeEpisode, result types
- `packages/core/src/driver/operations/episode-node-operations.ts` — 3 new methods
- `packages/core/src/driver/operations/entity-edge-operations.ts` — 5 new methods
- `packages/core/src/driver/operations/episodic-edge-operations.ts` — 4 new methods
- `packages/core/src/driver/operations/entity-node-operations.ts` — 2 new methods
- `packages/core/src/driver/operations/community-node-operations.ts` — 1 new method
- `packages/core/src/driver/neo4j/neo4j-episode-node-operations.ts` — 3 new methods
- `packages/core/src/driver/neo4j/neo4j-entity-edge-operations.ts` — 5 new methods
- `packages/core/src/driver/neo4j/neo4j-episodic-edge-operations.ts` — 4 new methods
- `packages/core/src/driver/neo4j/neo4j-entity-node-operations.ts` — 2 new methods
- `packages/core/src/driver/neo4j/neo4j-community-node-operations.ts` — 1 new method
- `packages/core/src/driver/falkordb/falkordb-episode-node-operations.ts` — 3 new methods
- `packages/core/src/driver/falkordb/falkordb-entity-edge-operations.ts` — 5 new methods
- `packages/core/src/driver/falkordb/falkordb-episodic-edge-operations.ts` — 4 new methods
- `packages/core/src/driver/falkordb/falkordb-entity-node-operations.ts` — 2 new methods
- `packages/core/src/driver/falkordb/falkordb-community-node-operations.ts` — 1 new method
- `packages/core/src/namespaces/edges.ts` — getBetweenNodes, getByNodeUuid, getByGroupIds, episodic edge CRUD

### Phase 2 — New Files (22)

**Operation interfaces (4):**
- `packages/core/src/driver/operations/saga-node-operations.ts`
- `packages/core/src/driver/operations/has-episode-edge-operations.ts`
- `packages/core/src/driver/operations/next-episode-edge-operations.ts`
- `packages/core/src/driver/operations/graph-maintenance-operations.ts`

**Operation implementations — Neo4j (4):**
- `packages/core/src/driver/neo4j/neo4j-saga-node-operations.ts`
- `packages/core/src/driver/neo4j/neo4j-has-episode-edge-operations.ts`
- `packages/core/src/driver/neo4j/neo4j-next-episode-edge-operations.ts`
- `packages/core/src/driver/neo4j/neo4j-graph-maintenance-operations.ts`

**Operation implementations — FalkorDB (4):**
- `packages/core/src/driver/falkordb/falkordb-saga-node-operations.ts`
- `packages/core/src/driver/falkordb/falkordb-has-episode-edge-operations.ts`
- `packages/core/src/driver/falkordb/falkordb-next-episode-edge-operations.ts`
- `packages/core/src/driver/falkordb/falkordb-graph-maintenance-operations.ts`

**Prompt system (7):**
- `packages/core/src/prompts/models.ts` — 12 response model interfaces
- `packages/core/src/prompts/snippets.ts` — shared SUMMARY_INSTRUCTIONS
- `packages/core/src/prompts/extract-nodes.ts` — 7 extraction prompt functions
- `packages/core/src/prompts/extract-edges.ts` — 2 edge extraction prompt functions
- `packages/core/src/prompts/dedupe-nodes.ts` — 3 node dedup prompt functions
- `packages/core/src/prompts/dedupe-edges.ts` — 1 edge dedup prompt function
- `packages/core/src/prompts/summarize-nodes.ts` — 3 summarization prompt functions
- `packages/core/src/prompts/lib.ts` — centralized prompt library registry

**Utilities (3):**
- `packages/core/src/utils/content-chunking.ts` — full content chunking system
- `packages/core/src/utils/text.ts` — luceneSanitize, normalizeL2, truncateAtSentence
- `packages/core/src/search/helpers.ts` — formatEdgeDateRange, searchResultsToContextString

### Phase 3 — New Files (8) + Modified Files (4)

**New files:**
- `packages/core/src/providers/llm/openai-generic-client.ts` — OpenAI-compatible generic LLM client
- `packages/core/src/llm/token-tracker.ts` — TokenUsage, PromptTokenUsage, TokenUsageTracker
- `packages/core/src/llm/cache.ts` — LLMCache with get/set/close
- `packages/core/src/llm/language.ts` — getExtractionLanguageInstruction
- `packages/core/src/prompts/eval.ts` — 4 eval prompts + 4 response models
- `packages/core/src/utils/entity-types.ts` — validateEntityTypes, validateExcludedEntityTypes
- `packages/core/src/search/utils.ts` — getMentionedNodes, getRelevantEdges/Nodes, getEdgeInvalidationCandidates

**Modified files:**
- `packages/core/src/graphiti.ts` — tokenTracker property, update_communities/extraction_instructions on IngestEpisodeInput
- `packages/core/src/driver/neo4j-driver.ts` — saga/hasEpisode/nextEpisode/graphOps wired into registry
- `packages/core/src/driver/falkordb-driver.ts` — same
- `packages/core/src/prompts/lib.ts` — eval prompts added to library
- `packages/core/src/providers/index.ts` — openai-generic-client export
- `packages/core/src/index.ts` — all new module exports

### Final Phase — New Files (6) + Modified Files (4)

**New files:**
- `packages/core/src/providers/reranker/bge-reranker.ts` — BGE Reranker REST API client
- `packages/core/src/providers/llm/gliner2-client.ts` — GLiNER2 entity extraction client
- `packages/core/src/telemetry.ts` — PostHog telemetry (isTelemetryEnabled, getAnonymousId, captureEvent)
- `packages/core/src/utils/concurrency.ts` — semaphoreGather bounded concurrency
- `packages/mcp/src/queue-service.ts` — per-group sequential episode processing queue

**Modified files:**
- `packages/core/src/tracing.ts` — added OpenTelemetrySpan, OpenTelemetryTracer
- `packages/core/src/utils/text.ts` — added buildFulltextQuery
- `packages/core/src/providers/index.ts` — BGE + GLiNER2 exports
- `packages/mcp/src/server.ts` — HTTP transport documentation
- `packages/mcp/src/index.ts` — queue-service export
- `packages/core/src/index.ts` — telemetry, concurrency exports

## Test Status

- **304 pass** (all phases)
- **0 fail**
- Type check: no new errors in any changed files

## Reference

- Prior PRD: `spec/typescript-port-prd.md`
- Architecture plan: `spec/bun-typescript-port-plan.md`
- Driver operations redesign: `spec/driver-operations-redesign.md`

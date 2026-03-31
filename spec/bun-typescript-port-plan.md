# Bun/TypeScript Port Plan

## Goal

Port Graphiti from Python to a Bun/TypeScript monorepo without breaking the existing Python release line before feature parity exists.

This repository currently contains three product surfaces:

- `graphiti_core/`: temporal graph library and ingestion/search engine
- `server/graph_service/`: FastAPI wrapper around the core library
- `mcp_server/src/`: MCP server with queueing, config, and database/provider factories

The TypeScript port should preserve the core external concepts:

- Graphiti client
- nodes, edges, episodes, communities
- temporal validity windows
- ingest and bulk ingest pipelines
- hybrid retrieval and reranking
- HTTP server
- MCP server

## Size And Risk Summary

- Approximate Python footprint inspected: `227` files / `51k` lines across core, services, and tests
- Highest-risk subsystem: `graphiti_core/driver/` with `76` files across Neo4j, FalkorDB, archived Kuzu support, and Neptune
- Most portable first slice: Neo4j + OpenAI + core ingest/search + HTTP/MCP facades
- Highest uncertainty for Bun compatibility: Neptune/OpenSearch stack, FalkorDB parity details, and MCP SDK runtime assumptions

## Monorepo Layout

The TypeScript workspace is scaffolded under `packages/`:

- `packages/shared`: config types, errors, tracing contracts, helpers, shared DTOs
- `packages/core`: Graphiti core TypeScript implementation
- `packages/server`: Bun-native HTTP API replacement for FastAPI
- `packages/mcp`: TypeScript MCP server
- `packages/testkit`: parity fixtures and integration harnesses

## Migration Principles

1. Keep Python working until TypeScript reaches subsystem parity.
2. Port behavior in thin vertical slices, not by blindly translating file-for-file.
3. Freeze observable contracts early: API shapes, env vars, error classes, and serialized graph objects.
4. Ship Neo4j + OpenAI first. Defer other providers until the core execution model is stable.
5. Use parity fixtures and integration tests rather than trusting manual inspection.

## Phase Plan

### Phase 0: Contract Freeze

- Inventory public imports from `graphiti_core`
- Inventory server routes from `server/graph_service/routers`
- Inventory MCP tools/resources/transports from `mcp_server/src/graphiti_mcp_server.py`
- Record env vars and optional dependency matrices from root/server/MCP `pyproject.toml`
- Capture representative ingest and search outputs for parity fixtures

Exit criteria:

- Public API inventory written down
- Feature matrix marked as `must-port`, `can-defer`, or `drop`
- Parity fixture corpus defined

### Phase 1: Workspace And Shared Foundations

- Add Bun workspaces and TypeScript project references
- Add package boundaries for core/server/MCP/shared/testkit
- Define base TS compiler settings
- Port shared primitives:
  - config loading
  - error hierarchy
  - time helpers
  - UUID generation
  - concurrency helpers
  - telemetry/tracing contracts

Exit criteria:

- `bun install` succeeds
- `bunx tsc -b` succeeds on scaffolds
- shared package exports stable primitives

### Phase 2: Domain Model Port

Map Python modules to TypeScript domains:

- `graphiti_core/nodes.py` -> `packages/core/src/domain/nodes/*`
- `graphiti_core/edges.py` -> `packages/core/src/domain/edges/*`
- `graphiti_core/search/search_config*.py` -> `packages/core/src/search/config/*`
- `graphiti_core/search/search_filters.py` -> `packages/core/src/search/filters/*`
- `graphiti_core/errors.py` -> `packages/shared/src/errors/*`
- `graphiti_core/helpers.py` -> `packages/shared/src/utils/*`

Use schema-first validation in TypeScript and keep serialized property names unchanged where practical.

Exit criteria:

- Domain entities and DTOs compile in TS
- Security validations for `group_id` and node labels are ported
- Unit tests exist for basic constructors and validators

### Phase 3: Driver Abstraction Port

Map:

- `graphiti_core/driver/driver.py` -> `packages/core/src/driver/graph-driver.ts`
- `graphiti_core/driver/query_executor.py` -> `packages/core/src/driver/query-executor.ts`
- `graphiti_core/driver/operations/*` -> `packages/core/src/driver/operations/*`

Execution order:

1. Neo4j
2. FalkorDB
3. Neptune/OpenSearch spike

Exit criteria:

- Neo4j driver supports sessions, transactions, search ops, and maintenance ops
- FalkorDB driver parity plan is validated against actual client capabilities
- Neptune is explicitly marked `port`, `bridge`, or `drop`
- Archived Kuzu support is removed from active TypeScript scope

### Phase 4: Provider Adapters Port

Map:

- `graphiti_core/llm_client/*` -> `packages/core/src/providers/llm/*`
- `graphiti_core/embedder/*` -> `packages/core/src/providers/embedder/*`
- `graphiti_core/cross_encoder/*` -> `packages/core/src/providers/reranker/*`

Initial scope:

- OpenAI only
- retry/backoff
- structured output support
- cache interface
- token accounting

Deferred providers:

- Anthropic
- Groq
- Gemini
- Voyage
- sentence-transformers / local models

Exit criteria:

- Graphiti core can run end-to-end with OpenAI-backed extraction and embeddings
- Adapter behavior is covered by contract tests and mocked provider tests

### Phase 5: Ingestion And Maintenance Port

Map:

- `graphiti_core/graphiti.py`
- `graphiti_core/utils/bulk_utils.py`
- `graphiti_core/utils/maintenance/*`
- `graphiti_core/prompts/*`

This phase should prioritize:

- single episode ingest
- bulk episode ingest
- node extraction
- edge extraction
- dedupe
- community maintenance only if required by tests or public API

Exit criteria:

- Ingest pipelines run on Neo4j with OpenAI
- parity fixtures pass for representative cases
- concurrency limits and failure handling are implemented

### Phase 6: Search Port

Map:

- `graphiti_core/search/search.py`
- `graphiti_core/search/search_utils.py`
- `graphiti_core/search/search_config_recipes.py`

Include:

- BM25/full-text
- vector similarity
- BFS traversal
- RRF/MMR reranking
- search filters

Exit criteria:

- Search returns stable result ordering within tolerated parity thresholds
- security-focused tests are ported first

### Phase 7: HTTP Server Port

Map:

- `server/graph_service/main.py`
- `server/graph_service/routers/*`
- `server/graph_service/dto/*`
- `server/graph_service/zep_graphiti.py`

Initial requirement:

- preserve route shapes and response DTOs before making any API redesign

Exit criteria:

- Bun-native server passes healthcheck and route contract tests
- Docker image builds and runs against Neo4j

### Phase 8: MCP Server Port

Map:

- `mcp_server/src/graphiti_mcp_server.py`
- `mcp_server/src/config/*`
- `mcp_server/src/services/*`
- `mcp_server/src/models/*`
- `mcp_server/src/utils/*`

Initial requirement:

- port stdio and HTTP transports
- preserve queueing and concurrency behavior
- preserve config precedence and entity-type configuration

Exit criteria:

- TypeScript MCP server runs against Neo4j or FalkorDB
- MCP integration tests cover tool registration and both transports

### Phase 9: Packaging, CI, And Cutover

- replace or supplement Python workflows with Bun workflows
- build TS server and MCP containers
- publish packages if the project will distribute the core as a package
- keep Python release automation until TS is production-ready

Exit criteria:

- CI runs TypeScript build, unit tests, and integration suites
- release paths exist for core, HTTP server, and MCP server

## Provider And Backend Strategy

### Ship First

- Database: Neo4j
- LLM: OpenAI
- Embedder: OpenAI
- Reranker: OpenAI-backed implementation if retained

### Port After Core Stabilizes

- FalkorDB
- Anthropic
- Gemini
- Groq
- Voyage

### Explicit Spike Required

- Neptune + OpenSearch
- MCP runtime behavior under Bun

### Dropped From Active TypeScript Scope

- Kuzu

Kuzu is no longer part of the active Bun/TypeScript migration plan because its upstream repository was archived on October 10, 2025. The replacement second backend for the TypeScript port is FalkorDB.

If any spike shows unacceptable runtime or maintenance cost, isolate that feature behind a compatibility boundary or keep it Python-only longer.

## Suggested Initial Work Queue

1. Port shared config/error/time utilities.
2. Port graph domain models and search config schemas.
3. Port Neo4j driver and minimal graph operations.
4. Port OpenAI LLM/embedder adapters.
5. Port single-episode ingest path.
6. Port search path.
7. Port HTTP server.
8. Port MCP server.
9. Expand provider/backend matrix.

## Deliverables For The Next Iteration

- Add concrete shared primitives under `packages/shared/src`
- Add first real TypeScript domain types under `packages/core/src`
- Add a Neo4j driver spike in TypeScript
- Add parity fixture format in `packages/testkit/src`

## Decision Log

- 2026-03-30: Chosen migration shape is a staged Bun/TypeScript monorepo that runs alongside Python until parity exists.
- 2026-03-30: Initial implementation focus is `Neo4j + OpenAI + core ingest/search`, followed by HTTP server, then MCP.
- 2026-03-30: Kuzu removed from active Bun/TypeScript backend scope because the upstream repository is archived; FalkorDB is the secondary backend after Neo4j.

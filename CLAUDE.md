# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`graphiti-ts` is a TypeScript port of [getzep/graphiti](https://github.com/getzep/graphiti) — a temporally-aware knowledge graph for agent memory. It extends the original with epistemic features (edge quality gating, epistemic status lifecycle, confidence bands, staleness scoring, deprecation gate, contextual anchoring, conditional edges). See `README.md` for the full feature matrix and the "What's Different from the Python Original" table.

Bun workspaces monorepo (`packages/*`). Runtime targets both Bun and Node.

## Commands

```bash
bun install                 # install all workspace deps
bun run build               # build every package (esm bundle + tsc declarations)
bun run typecheck           # tsc --noEmit across all packages
bun run test                # run all package tests (bun test)
bun run lint                # biome check .
bun run format              # biome format --write .
bun run verify              # full gate: check:no-pai-leaks → build → typecheck → test
```

Run a single test file or test name (Bun's runner):

```bash
cd packages/core && bun test src/domain/staleness.test.ts
cd packages/core && bun test -t "deprecates edge"
```

Integration tests (Neo4j/FalkorDB) live next to unit tests as `*.integration.test.ts` and self-skip unless their env vars are set (e.g. `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`). Plain `bun run test` is safe to run with no database — those tests skip.

### Formatting

Biome with **tabs**, single quotes, semicolons, 100-char width (`biome.json`). Import organization is on. Match this; don't introduce spaces-for-indent.

## Release workflow

`dist/` is treated as a **release artifact**, not a source-of-truth committed during normal iteration.

```bash
bun run release:cut -- v0.2.0          # rebuild dist, run full verify, assert worktree clean after
bun run release:cut -- v0.2.0 --tag    # same, then create the git tag
```

The cut fails if build/test mutated the worktree (forcing you to commit rebuilt artifacts deliberately) and enforces the PAI-leak boundary check below.

### Repository boundary check (important)

`scripts/check-no-pai-leaks.sh` greps `packages/`, README, CHANGELOG, docs, and `config.sample.yaml` for the pattern `Infrastructure/|Hooks/|Skills/|PAI/` and **fails the build** if any match. This repo is consumed inside a larger private PAI system; the reusable surface must stay free of PAI-specific paths. Don't reference those directories anywhere in the published surface.

## Architecture

Three packages:
- `@graphiti/core` — the library (everything below)
- `@graphiti/mcp` — MCP server wrapping core (`server.ts`, `queue-service.ts`)
- `@graphiti/shared` — zero-dep utilities: errors, time, validation, graph types, migration

### The central seam: `Graphiti` + injected clients

`packages/core/src/graphiti.ts` (the ~1900-line `Graphiti` class) is the orchestrator. It depends only on four injected interfaces defined in `contracts.ts` — everything is swappable:

- `GraphDriver` — graph backend (Neo4j or FalkorDB)
- `LLMClient` — entity/edge extraction, dedup, resolution
- `EmbedderClient` — vector embeddings
- `CrossEncoderClient` — reranking

Construct with either a connection (`{ uri, user, password }` → builds a Neo4j driver) or a pre-built `{ driver }`, plus optional `llm_client` / `embedder` / `cross_encoder` (default to OpenAI providers when omitted). Policy is passed via `config` (`GraphitiConfigOverrides`).

### Driver abstraction (two-layer)

`GraphDriver` is the thin connection/transaction interface. The actual graph reads/writes are **per-entity operation classes** with a backend-neutral interface and one implementation per backend:

- `src/driver/operations/*` — interfaces (`entity-edge-operations`, `entity-node-operations`, `episode-node-operations`, `community-*`, `saga-node-operations`, `graph-maintenance-operations`, …)
- `src/driver/neo4j/*` and `src/driver/falkordb/*` — concrete implementations

When adding a graph operation, you generally touch the interface **and both** backend implementations. Kuzu/Neptune from the Python original are intentionally absent.

### Ingestion pipeline (`addEpisode` / `ingestEpisode`)

The flow, by directory:
1. `ingest/` — `extractor` (heuristic + model episode extractors), `hydrator` (node hydration), `resolver` (resolves extraction results)
2. `maintenance/` — `node-operations` & `edge-operations` (LLM extraction of entities/relationships, attribute hydration), `bulk-utils` (parallel bulk ingest + cross-episode dedup), `negation` (regex pre-filter that short-circuits LLM contradiction checks for obvious negations like "no longer uses")
3. `dedup/` — `dedup-helpers` (MinHash candidate indexing, similarity resolution — CJK-aware shingle sizes) and `union-find`
4. `domain/` — the data model and epistemic logic (see below)
5. `community/` — community detection (GDS Leiden when available, label-propagation fallback) with batched LLM summarization

### Domain model & epistemic extensions (`src/domain/`)

This is where this port diverges most from upstream. Each concept is a module with a colocated test:
- `edges.ts` / `nodes.ts` — core graph types (`EntityEdge`, `EntityNode`, `EpisodicNode`, `CommunityNode`, `SagaNode`, …)
- `edge-quality.ts` — birth-gate weighted scoring that filters low-value edges at ingestion
- `epistemic.ts` — nine-state assertion lifecycle (fact/claim/disputed/decision/opinion/hypothesis/observation/preference/deprecated) with transition audit trail
- `deprecation-gate.ts` — evidence-weighted contradiction resolution (four-tier: ignore/dispute/deprecate/replace)
- `staleness.ts` — query-time freshness signal, **never stored**, computed on the fly
- `conditions.ts` — `EdgeCondition`: facts true only under specific conditions
- `anchoring.ts` — interpretive-dependency tracking and graduated confidence erosion

These additions are additive/non-breaking: they extend `EntityEdge` with optional fields. Preserve that — don't make new lifecycle/reasoning fields required.

### Search (`src/search/`)

Hybrid retrieval: semantic embeddings + BM25 fulltext + graph traversal, combined via RRF / node-distance reranking. `recipes.ts` holds named search configs; `filters.ts` includes temporal (`searchAsOf`) filtering against the bi-temporal model.

### Providers (`src/providers/`)

`llm/`, `embedder/`, `reranker/` each hold one client per provider, all implementing the corresponding `contracts.ts` interface. Most non-OpenAI providers (Groq, Azure, Ollama, generic) are OpenAI-SDK-compatible variants. Per-prompt model routing is configured via `GraphitiModelRoutingConfig` (keys are prompt names like `dedupe_nodes.nodes` or prefixes like `extract_nodes.*`).

### Prompts (`src/prompts/`)

LLM prompt templates as data, surfaced through `promptLibrary` (`prompts/lib.ts`). Extraction/dedup behavior is driven from here.

### Config

`src/config.ts` defines the typed `GraphitiConfig` / `GraphitiConfigOverrides` (extraction, community, bulk_ingest, resolution, lifecycle, model_routing) merged at client construction via `createGraphitiConfig(options.config)` (`graphiti.ts:231`).

**Config is never read from a file — not from cwd, not from the home directory.** `config.yaml` / `config.sample.yaml` at the repo root is documentation/template only; nothing in `packages/*/src` parses YAML. Config reaches `Graphiti` purely as the typed overrides object passed to the constructor. Whatever loads YAML into that object lives outside this repo (the consuming deployment). The MCP server's config (`packages/mcp/src/config.ts`) is likewise an in-memory `{ default_group_id }` default, no file.

> **TODO / unimplemented:** there is currently no YAML config loader in this codebase. `config.sample.yaml` describes a shape nothing here reads. The README previously claimed `config.yaml` is "read by config.ts at module load time" — that loader does not exist yet (likely not ported from the Python original). If/when a file-based loader is added, decide its search path deliberately (cwd vs `~/.config/graphiti` vs explicit path). Until then, all config is programmatic.

The **only** home-directory access in the entire source tree is the anonymous telemetry install-ID: `telemetry.ts` reads/writes `~/.cache/graphiti/telemetry_anon_id` (`homedir()`, `telemetry.ts:33`). That is not application config — don't go hunting for a home-dir config file; there isn't one.

### Observability

OpenTelemetry tracing via `tracing.ts` (injectable `Tracer`, `NoOpTracer` default). Anonymous usage telemetry in `telemetry.ts` (PostHog; persists an install ID at `~/.cache/graphiti/telemetry_anon_id`, disabled via `GRAPHITI_TELEMETRY_ENABLED=false`). Token accounting in `llm/token-tracker.ts`; LLM response caching in `llm/cache.ts`.

## Public API surface

Everything is re-exported from `packages/core/src/index.ts`. When adding a new module that should be consumable, add its export there — it's the single barrel and the contract for downstream consumers.

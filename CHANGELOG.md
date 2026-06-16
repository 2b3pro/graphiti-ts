# Changelog

## v0.2.6

### Wire epistemic domain model into the default runtime path (roadmap Phase 1)

- **Conditional edges now persist end to end.** The extraction prompt already requested `conditions`, but `ExtractedEdge` dropped them at parse time. `extractEdges()` now maps each returned condition's `entity_name` → `entity_uuid` via the existing name-to-node map, validates it with `validateConditions()`, and attaches it to the saved edge (the serialize/read round-trip already handled `EdgeCondition[]`). A condition referencing an unknown entity or with a malformed shape is **dropped while the edge is kept**, and each drop emits a `condition_drop` metric span (`reason`, `group_id`, `relation_type`) for regression visibility. Note: conditions are persisted but not yet auto-applied in public search — `evaluateConditions()` remains a post-query helper (search-time filtering is a follow-up).
- **MCP `add_memory` now uses the full pipeline.** It routes through `addEpisodeFull()` (custom entity/edge types, edge maps, deprecation gate, conditions) instead of the lighter `ingestEpisode()`. When an LLM client, embedder, and cross encoder are not all configured, `addEpisodeFull()` **degrades gracefully to `ingestEpisode()`** instead of throwing — emitting an `add_episode_full_fallback` metric on every occurrence (rate-limited console warning) that names any richer capabilities (`saga`, `edge_type_map`, custom types, …) silently dropped on the degraded path.
- **`dedupeEdgesBulk()` no longer scales O(n²).** Candidate edges are pre-bucketed by `(source_uuid, target_uuid)` and fact word-sets are precomputed once per edge, replacing the per-pair rescan and per-comparison word-set rebuild. Behavior-preserving — edges sharing a node-pair across different relation types are still compared as before.
- **Docs:** README feature table corrected from "YAML-driven config" to "typed programmatic config; `config.sample.yaml` documents the shape for deployment loaders," matching the absence of an in-repo YAML loader.

## v0.2.5

### Upstream fix parity and provider hardening

- **Search filter hardening:** `property_filters.property_name` now validates as a safe Cypher identifier before query construction. This closes an injection-shaped footgun for dynamic edge property filters and reuses the same identifier rules as node labels.
- **Structured attribute guards:** Node and edge attribute extraction now drops empty/null-stand-in strings (`null`, `none`, `n/a`, `unknown`) and overlong generated strings before merging LLM output into graph records. Field schemas can set `maxLength`/`max_length`; otherwise `GRAPHITI_ATTRIBUTE_MAX_LENGTH` or the built-in default applies.
- **Prompt tightening:** Node and edge attribute prompts now explicitly require source-supported values and discourage guessed or placeholder attributes.
- **OpenAI-compatible structured output:** `OpenAIGenericClient` now prefers native `json_schema` response format when a response model is provided, with automatic fallback to the prior `json_object` prompt path for providers that do not support `json_schema`. Set `structured_output_mode: 'json_object'` to force the old behavior.
- **MCP `group_ids` compatibility:** MCP tools now accept either a scalar group id (`"team-a"`) or an array (`["team-a"]`) for `search_nodes`, `search_memory_facts`, `get_episodes`, and `clear_graph`.

## v0.2.4

### Temporal filter correctness (fixes silent empty results)

- **`searchAsOf()` returned 0 edges for every date.** Two compounding bugs, both fixed:
  - The `invalid_at` conditions were packed into one inner `DateFilter[]` array, which `appendDateFilters` AND-joins — producing `(invalid_at > d AND invalid_at IS NULL)`, a contradiction that matches nothing. They are now in separate OR-groups: `(invalid_at > d) OR (invalid_at IS NULL)`.
  - Date properties are persisted as ISO-8601 **strings** (`serializeForCypher`), but `DateFilter` passed a JS `Date`, which the driver serializes to a Neo4j `DateTime`; `string <op> datetime` is a silent type mismatch that matches nothing.
- **All date params now route through `serializeForCypher`** at the query boundary — one canonical contract, symmetric with the write side. This also fixes the same latent mismatch in `deprecateEdges({ older_than })` (was a permanent no-op), the `deprecateEdges` write of `deprecated_at` (was poisoning `invalid_at` with a `DateTime`), and `EpisodeNodeNamespace.getByGroupIds(referenceTime)`.
- `DateFilter.date` widened to `Date | string` and documented (an ISO string may be passed directly).
- **Tests:** the prior `searchAsOf` test passed despite the bug because its fake driver ignored the WHERE clause. Added Cypher-construction assertions (`search/filters.asof.test.ts`) and param-capture tests (`deprecateEdges` older_than/deprecated_at, `retrieveEpisodes` reference_time) that catch the bug class a fake driver can't.

## v0.2.3

- **`bulk_edge_resolution_max_concurrency`:** throttle edge-resolution fan-out in bulk ingestion to avoid saturating the LLM gateway.
- **`fix(dedup)`:** strip trailing punctuation from facts at ingestion and comparison time so `"X."` and `"X"` dedup correctly.

## v0.2.2

- **Configurable `candidate_expansion`** in search config + **BGE reranker batch chunking** to keep cross-encoder request sizes bounded.

## v0.2.1

### Resolution & inference optimization

- **Resolution pre-filter:** Config-gated similarity pre-filter (`resolution.pre_filter_enabled`) with margin-aware skip logic for node and edge resolution. Skips LLM dedup calls when candidates are clearly non-matches (low similarity + weak margin). Controlled by `node_similarity_threshold`, `edge_similarity_threshold`, and `margin_threshold`.
- **Resolution decision logging:** `log_decisions` flag emits structured JSON for every resolution decision (skipped or LLM-resolved). `log_destination` routes output to a JSONL file instead of console, enabling post-hoc threshold analysis.
- **`logResolutionDecision()` helper:** Centralized log routing in `config.ts` — file append when `log_destination` is set, console.info fallback. Both node-operations and edge-operations use it.
- **Edge scores in bulk path:** `dedupeEdgesBulk()` now computes and passes cosine similarity scores to `resolveExtractedEdge()` (was `[]`), enabling the edge pre-filter in bulk ingestion.

### LLM client improvements

- **Rate limit retry with backoff:** `OpenAIGenericClient` now retries 429/rate-limit errors with exponential backoff (3s base, up to 4 retries) instead of failing immediately. Fixes gateway overload causing total ingestion failure.
- **`small_model` wiring:** `generateText()` accepts optional `model_override` parameter. `generateResponse()` passes `client.small_model` when `model_size: 'small'` is requested.
- **Per-prompt model routing (`model_routing` config):** Maps prompt names (or `prefix.*` globs) to specific model identifiers. Enables fine-grained control: extraction on sonnet, resolution on sonnet, attribute hydration on haiku — all configurable per deployment. Resolution order: exact prompt name → prefix match → `model_size` fallback → `client.model` default. See `GraphitiModelRoutingConfig` and `resolveModelForPrompt()` in `config.ts`.

### Future consideration

- **Hook/plugin pattern:** Explore whether a post-extraction hook or plugin architecture would allow consumers to inject custom enrichment (e.g., epistemic classification, quality scoring, citation extraction) without modifying core extraction prompts. PAI currently runs a second-pass overlay for this; a first-class hook on `addEpisodeFull`/`addEpisodeBulkFull` would eliminate that second pass. Design questions: callback vs event emitter, what data the hook receives (episode UUID, created edge UUIDs + triples, episode text), and whether hooks can reject/modify edges before persistence.

## v0.2.0

- Add `EpisodeTypes.document` for document-oriented ingestion.
- Wire `custom_extraction_instructions` into node and edge extraction prompts.
- Stabilize bulk persistence so full-ingestion paths preserve the complete node and edge schema.
- Refactor `Graphiti` driver scoping so FalkorDB group/database routing is operation-scoped instead of mutating shared namespaces.
- Remove fake transaction semantics from write paths that were not actually transactional.
- Scope community rebuild cleanup to the requested `group_id` set.
- Expand group deletion to remove all group-owned graph objects by `group_id`.
- Normalize edge deprecation metadata as first-class persisted/read fields.
- Add typed `Graphiti` policy config for extraction defaults, community strategy, bulk embedding batching, and deprecation-gate tuning.
- Keep lifecycle additions additive and backward-compatible:
  `deprecateEdge()`, `deprecateEdges()`, `searchAsOf()`, confidence, epistemic fields, conditions, and interpretations.
- Compatibility note: consumers that strictly decode serialized `EntityEdge` payloads must tolerate newly added optional lifecycle and reasoning fields.

## v0.1.0

- Initial TypeScript port of Graphiti with Neo4j/FalkorDB support, embeddings, reranking, and MCP packaging.

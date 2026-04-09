# Changelog

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

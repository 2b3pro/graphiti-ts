# Changelog

## v0.2.0 (planned)

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

## v0.1.0

- Initial TypeScript port of Graphiti with Neo4j/FalkorDB support, embeddings, reranking, and MCP packaging.

/**
 * LLM prompt response models — port of Python Pydantic models.
 *
 * These define the expected JSON response shapes from LLM calls
 * across extraction, deduplication, and summarization prompts.
 */

// --- Extract Nodes ---

export interface ExtractedEntity {
  name: string;
  entity_type_id: number;
}

export interface ExtractedEntities {
  extracted_entities: ExtractedEntity[];
}

export interface EntitySummary {
  summary: string;
}

export interface SummarizedEntity {
  name: string;
  summary: string;
}

export interface SummarizedEntities {
  summaries: SummarizedEntity[];
}

// --- Extract Edges ---

export interface ExtractedEdge {
  source_entity_name: string;
  target_entity_name: string;
  relation_type: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
}

export interface ExtractedEdges {
  edges: ExtractedEdge[];
}

// --- Dedupe Nodes ---

export interface NodeDuplicate {
  id: number;
  name: string;
  duplicate_name: string;
}

export interface NodeResolutions {
  entity_resolutions: NodeDuplicate[];
}

// --- Dedupe Edges ---

export interface EdgeDuplicate {
  duplicate_facts: number[];
  contradicted_facts: number[];
}

// --- Summarize Nodes ---

export interface Summary {
  summary: string;
}

export interface SummaryDescription {
  description: string;
}

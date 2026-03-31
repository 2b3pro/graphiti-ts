import type { EntityEdge } from '../domain/edges';
import type { SearchResults } from './config';

/**
 * Format an edge's valid_at/invalid_at as a human-readable date range.
 * Port of Python's format_edge_date_range().
 */
export function formatEdgeDateRange(edge: EntityEdge): string {
  const validAt = edge.valid_at ? edge.valid_at.toISOString() : 'unknown';
  const invalidAt = edge.invalid_at ? edge.invalid_at.toISOString() : 'present';
  return `${validAt} - ${invalidAt}`;
}

/**
 * Convert SearchResults into a context string suitable for LLM prompts.
 * Port of Python's search_results_to_context_string().
 */
export function searchResultsToContextString(searchResults: SearchResults): string {
  const parts: string[] = [];

  if (searchResults.edges.length > 0) {
    const factsJson = searchResults.edges.map((edge) => ({
      fact: edge.fact,
      valid_at: edge.valid_at?.toISOString() ?? null,
      invalid_at: edge.invalid_at?.toISOString() ?? null
    }));
    parts.push(`<facts>\n${JSON.stringify(factsJson, null, 2)}\n</facts>`);
  }

  if (searchResults.nodes.length > 0) {
    const entitiesJson = searchResults.nodes.map((node) => ({
      name: node.name,
      summary: node.summary
    }));
    parts.push(`<entities>\n${JSON.stringify(entitiesJson, null, 2)}\n</entities>`);
  }

  if (searchResults.episodes.length > 0) {
    const episodesJson = searchResults.episodes.map((ep) => ({
      content: ep.content,
      valid_at: ep.valid_at?.toISOString() ?? null
    }));
    parts.push(`<episodes>\n${JSON.stringify(episodesJson, null, 2)}\n</episodes>`);
  }

  if (searchResults.communities.length > 0) {
    const communitiesJson = searchResults.communities.map((c) => ({
      name: c.name,
      summary: c.summary
    }));
    parts.push(`<communities>\n${JSON.stringify(communitiesJson, null, 2)}\n</communities>`);
  }

  return parts.join('\n\n');
}

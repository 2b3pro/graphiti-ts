import { GraphProviders } from '@graphiti/shared';

import type { GraphDriver } from '../../contracts';
import type { EntityEdge } from '../../domain/edges';
import type { CommunityNode, EntityNode, EpisodicNode } from '../../domain/nodes';
import { mapEntityEdge } from '../../namespaces/edges';
import { mapCommunityNode } from '../../namespaces/communities';
import { mapEntityNode, mapEpisodeNode } from '../../namespaces/nodes';
import type { SearchFilters } from '../../search/filters';
import {
  edgeSearchFilterQueryConstructor,
  nodeSearchFilterQueryConstructor
} from '../../search/filters';
import { rankByCosineSimilarity } from '../../search/ranking';
import { getRecordValue, type RecordLike } from '../../utils/records';
import type { SearchOperations } from '../operations/search-operations';

export class FalkorSearchOperations implements SearchOperations {
  async nodeSimilaritySearch(
    driver: GraphDriver,
    queryEmbedding: number[],
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit = 10,
    minScore = 0
  ): Promise<EntityNode[]> {
    const { clause, params } = buildNodeVectorWhereClause(searchFilter, groupIds);
    params.search_vector = queryEmbedding;
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)
        ${clause}
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.name_embedding AS name_embedding,
          n.summary AS summary,
          n.attributes AS attributes
      `,
      {
        params,
        routing: 'r'
      }
    );

    return rankByCosineSimilarity(
      result.records.map((record) => mapEntityNode(record)),
      queryEmbedding,
      (node) => node.name_embedding,
      (node) => node.uuid,
      minScore,
      limit
    );
  }

  async edgeSimilaritySearch(
    driver: GraphDriver,
    queryEmbedding: number[],
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit = 10,
    minScore = 0
  ): Promise<EntityEdge[]> {
    const { clause, params } = buildEdgeVectorWhereClause(searchFilter, groupIds);
    params.search_vector = queryEmbedding;
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)
        ${clause}
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.name AS name,
          e.fact AS fact,
          e.fact_embedding AS fact_embedding,
          e.episodes AS episodes,
          e.expired_at AS expired_at,
          e.valid_at AS valid_at,
          e.invalid_at AS invalid_at,
          e.confidence AS confidence,
          e.epistemic_status AS epistemic_status,
          e.supported_by AS supported_by,
          e.supports AS supports,
          e.disputed_by AS disputed_by,
          e.epistemic_history AS epistemic_history,
          e.birth_score AS birth_score
      `,
      {
        params,
        routing: 'r'
      }
    );

    return rankByCosineSimilarity(
      result.records.map((record) => mapEntityEdge(record)),
      queryEmbedding,
      (edge) => edge.fact_embedding,
      (edge) => edge.uuid,
      minScore,
      limit
    );
  }

  async nodeFulltextSearch(
    driver: GraphDriver,
    query: string,
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit = 10
  ): Promise<EntityNode[]> {
    const { clause, params } = buildNodeSearchWhereClause(query, searchFilter, groupIds);
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)
        ${clause}
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.name_embedding AS name_embedding,
          n.summary AS summary,
          n.attributes AS attributes
        ORDER BY n.name ASC
        LIMIT $limit
      `,
      {
        params: {
          ...params,
          limit
        },
        routing: 'r'
      }
    );

    return result.records.map((record) => mapEntityNode(record));
  }

  async edgeFulltextSearch(
    driver: GraphDriver,
    query: string,
    searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit = 10
  ): Promise<EntityEdge[]> {
    const { clause, params } = buildEdgeSearchWhereClause(query, searchFilter, groupIds);
    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity)
        ${clause}
        RETURN
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.name AS name,
          e.fact AS fact,
          e.fact_embedding AS fact_embedding,
          e.episodes AS episodes,
          e.expired_at AS expired_at,
          e.valid_at AS valid_at,
          e.invalid_at AS invalid_at,
          e.confidence AS confidence,
          e.epistemic_status AS epistemic_status,
          e.supported_by AS supported_by,
          e.supports AS supports,
          e.disputed_by AS disputed_by,
          e.epistemic_history AS epistemic_history,
          e.birth_score AS birth_score
        ORDER BY e.name ASC, e.uuid ASC
        LIMIT $limit
      `,
      {
        params: {
          ...params,
          limit
        },
        routing: 'r'
      }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async nodeBfsSearch(
    driver: GraphDriver,
    originNodeUuids: string[] | null | undefined,
    searchFilter: SearchFilters,
    maxDepth = 3,
    groupIds?: string[] | null,
    limit = 10
  ): Promise<EntityNode[]> {
    const originUuids = normalizeOriginNodeUuids(originNodeUuids);
    if (originUuids.length === 0) {
      return [];
    }

    const depth = normalizeMaxDepth(maxDepth);
    const { clause, params } = buildNodeBfsWhereClause(
      originUuids,
      searchFilter,
      groupIds
    );
    const result = await driver.executeQuery<RecordLike>(
      `
        UNWIND $origin_node_uuids AS origin_uuid
        MATCH (origin:Entity {uuid: origin_uuid})
        MATCH path = (origin)-[:RELATES_TO*1..${depth}]-(n:Entity)
        ${clause}
        RETURN DISTINCT
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.name_embedding AS name_embedding,
          n.summary AS summary,
          n.attributes AS attributes
        ORDER BY n.name ASC, n.uuid ASC
        LIMIT $limit
      `,
      {
        params: {
          ...params,
          limit
        },
        routing: 'r'
      }
    );

    return result.records.map((record) => mapEntityNode(record));
  }

  async edgeBfsSearch(
    driver: GraphDriver,
    originNodeUuids: string[] | null | undefined,
    searchFilter: SearchFilters,
    maxDepth = 3,
    groupIds?: string[] | null,
    limit = 10
  ): Promise<EntityEdge[]> {
    const originUuids = normalizeOriginNodeUuids(originNodeUuids);
    if (originUuids.length === 0) {
      return [];
    }

    const depth = normalizeMaxDepth(maxDepth);
    const { clause, params } = buildEdgeBfsWhereClause(
      originUuids,
      searchFilter,
      groupIds
    );
    const result = await driver.executeQuery<RecordLike>(
      `
        UNWIND $origin_node_uuids AS origin_uuid
        MATCH (origin:Entity {uuid: origin_uuid})
        MATCH path = (origin)-[:RELATES_TO*1..${depth}]-(neighbor:Entity)
        UNWIND relationships(path) AS e
        WITH DISTINCT e
        MATCH (n:Entity)-[e]->(m:Entity)
        ${clause}
        RETURN DISTINCT
          e.uuid AS uuid,
          e.group_id AS group_id,
          n.uuid AS source_node_uuid,
          m.uuid AS target_node_uuid,
          e.created_at AS created_at,
          e.name AS name,
          e.fact AS fact,
          e.fact_embedding AS fact_embedding,
          e.episodes AS episodes,
          e.expired_at AS expired_at,
          e.valid_at AS valid_at,
          e.invalid_at AS invalid_at,
          e.confidence AS confidence,
          e.epistemic_status AS epistemic_status,
          e.supported_by AS supported_by,
          e.supports AS supports,
          e.disputed_by AS disputed_by,
          e.epistemic_history AS epistemic_history,
          e.birth_score AS birth_score
        ORDER BY e.name ASC, e.uuid ASC
        LIMIT $limit
      `,
      {
        params: {
          ...params,
          limit
        },
        routing: 'r'
      }
    );

    return result.records.map((record) => mapEntityEdge(record));
  }

  async nodeDistanceReranker(
    driver: GraphDriver,
    nodeUuids: string[],
    centerNodeUuid: string,
    minScore = 0
  ): Promise<{ uuids: string[]; scores: number[] }> {
    const normalizedNodeUuids = normalizeOriginNodeUuids(nodeUuids);
    if (normalizedNodeUuids.length === 0) {
      return { uuids: [], scores: [] };
    }

    const result = await driver.executeQuery<RecordLike>(
      `
        UNWIND $node_uuids AS node_uuid
        MATCH (center:Entity {uuid: $center_uuid})
        MATCH (candidate:Entity {uuid: node_uuid})
        OPTIONAL MATCH path = shortestPath((center)-[:RELATES_TO*]-(candidate))
        RETURN
          node_uuid AS uuid,
          CASE
            WHEN node_uuid = $center_uuid THEN 0.1
            WHEN path IS NULL THEN 1000000.0
            ELSE toFloat(length(path))
          END AS distance
        ORDER BY distance ASC, uuid ASC
      `,
      {
        params: {
          node_uuids: normalizedNodeUuids,
          center_uuid: centerNodeUuid
        },
        routing: 'r'
      }
    );

    const ranked = result.records
      .map((record) => {
        const uuid = getRecordValue<string>(record, 'uuid') ?? '';
        const distance = Number(
          getRecordValue(record, 'distance') ?? Number.POSITIVE_INFINITY
        );

        return {
          uuid,
          score: distance > 0 ? 1 / distance : 0
        };
      })
      .filter((entry) => entry.uuid !== '' && entry.score >= minScore);

    return {
      uuids: ranked.map((entry) => entry.uuid),
      scores: ranked.map((entry) => entry.score)
    };
  }

  async episodeMentionsReranker(
    driver: GraphDriver,
    nodeUuids: string[],
    minScore = 0
  ): Promise<{ uuids: string[]; scores: number[] }> {
    const normalizedNodeUuids = normalizeOriginNodeUuids(nodeUuids);
    if (normalizedNodeUuids.length === 0) {
      return { uuids: [], scores: [] };
    }

    const result = await driver.executeQuery<RecordLike>(
      `
        UNWIND $node_uuids AS node_uuid
        MATCH (n:Entity {uuid: node_uuid})
        OPTIONAL MATCH (:Episodic)-[:MENTIONS]->(n)
        RETURN node_uuid AS uuid, count(*) AS mentions
        ORDER BY mentions DESC, uuid ASC
      `,
      {
        params: {
          node_uuids: normalizedNodeUuids
        },
        routing: 'r'
      }
    );

    const ranked = result.records
      .map((record) => ({
        uuid: getRecordValue<string>(record, 'uuid') ?? '',
        score: Number(getRecordValue(record, 'mentions') ?? 0)
      }))
      .filter((entry) => entry.uuid !== '' && entry.score >= minScore);

    return {
      uuids: ranked.map((entry) => entry.uuid),
      scores: ranked.map((entry) => entry.score)
    };
  }

  async episodeFulltextSearch(
    driver: GraphDriver,
    query: string,
    _searchFilter: SearchFilters,
    groupIds?: string[] | null,
    limit = 10
  ): Promise<EpisodicNode[]> {
    const params: Record<string, unknown> = {
      query_lower: query.toLowerCase(),
      limit
    };
    const queries = [
      '(toLower(coalesce(n.name, "")) CONTAINS $query_lower OR toLower(coalesce(n.content, "")) CONTAINS $query_lower OR toLower(coalesce(n.source_description, "")) CONTAINS $query_lower)'
    ];

    if (groupIds && groupIds.length > 0) {
      queries.push('n.group_id IN $group_ids');
      params.group_ids = groupIds;
    }

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (n:Episodic)
        WHERE ${queries.join(' AND ')}
        RETURN
          n.uuid AS uuid,
          n.name AS name,
          n.group_id AS group_id,
          coalesce(n.labels, labels(n)) AS labels,
          n.created_at AS created_at,
          n.source AS source,
          n.source_description AS source_description,
          n.content AS content,
          n.valid_at AS valid_at,
          n.entity_edges AS entity_edges
        ORDER BY n.created_at DESC
        LIMIT $limit
      `,
      {
        params,
        routing: 'r'
      }
    );

    return result.records.map((record) => mapEpisodeNode(record));
  }

  async communityFulltextSearch(
    driver: GraphDriver,
    query: string,
    groupIds?: string[] | null,
    limit = 20
  ): Promise<CommunityNode[]> {
    const params: Record<string, unknown> = {
      query_lower: query.toLowerCase(),
      limit
    };
    const whereClauses: string[] = [
      '(toLower(coalesce(c.name, "")) CONTAINS $query_lower OR toLower(coalesce(c.summary, "")) CONTAINS $query_lower)'
    ];

    if (groupIds && groupIds.length > 0) {
      whereClauses.push('c.group_id IN $group_ids');
      params.group_ids = groupIds;
    }

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (c:Community)
        WHERE ${whereClauses.join(' AND ')}
        RETURN
          c.uuid AS uuid,
          c.name AS name,
          c.group_id AS group_id,
          coalesce(c.labels, labels(c)) AS labels,
          c.created_at AS created_at,
          c.summary AS summary,
          c.name_embedding AS name_embedding,
          c.rank AS rank
        LIMIT $limit
      `,
      { params, routing: 'r' }
    );

    return result.records.map((record) => mapCommunityNode(record));
  }

  async communitySimilaritySearch(
    driver: GraphDriver,
    queryEmbedding: number[],
    groupIds?: string[] | null,
    limit = 20,
    minScore = 0.6
  ): Promise<CommunityNode[]> {
    const params: Record<string, unknown> = { limit, search_vector: queryEmbedding };
    const whereClauses: string[] = [
      'c.name_embedding IS NOT NULL',
      'size(c.name_embedding) = size($search_vector)'
    ];

    if (groupIds && groupIds.length > 0) {
      whereClauses.push('c.group_id IN $group_ids');
      params.group_ids = groupIds;
    }

    const result = await driver.executeQuery<RecordLike>(
      `
        MATCH (c:Community)
        WHERE ${whereClauses.join(' AND ')}
        RETURN
          c.uuid AS uuid,
          c.name AS name,
          c.group_id AS group_id,
          coalesce(c.labels, labels(c)) AS labels,
          c.created_at AS created_at,
          c.summary AS summary,
          c.name_embedding AS name_embedding,
          c.rank AS rank
        LIMIT $limit
      `,
      { params, routing: 'r' }
    );

    const communities = result.records.map((record) => mapCommunityNode(record));
    return rankByCosineSimilarity(communities, queryEmbedding, (c) => c.name_embedding, (c) => c.uuid, minScore);
  }
}

function buildNodeSearchWhereClause(
  query: string,
  searchFilter: SearchFilters,
  groupIds?: string[] | null
): { clause: string; params: Record<string, unknown> } {
  const [filterQueries, filterParams] = nodeSearchFilterQueryConstructor(
    searchFilter,
    GraphProviders.FALKORDB
  );
  const params: Record<string, unknown> = {
    ...filterParams,
    query_lower: query.toLowerCase()
  };
  const queries = [
    '(toLower(coalesce(n.name, "")) CONTAINS $query_lower OR toLower(coalesce(n.summary, "")) CONTAINS $query_lower)'
  ];

  if (groupIds && groupIds.length > 0) {
    queries.push('n.group_id IN $group_ids');
    params.group_ids = groupIds;
  }

  queries.push(...filterQueries);

  return {
    clause: queries.length > 0 ? `WHERE ${queries.join(' AND ')}` : '',
    params
  };
}

function buildNodeVectorWhereClause(
  searchFilter: SearchFilters,
  groupIds?: string[] | null
): { clause: string; params: Record<string, unknown> } {
  const [filterQueries, filterParams] = nodeSearchFilterQueryConstructor(
    searchFilter,
    GraphProviders.FALKORDB
  );
  const params: Record<string, unknown> = { ...filterParams };
  const queries = [
    'n.name_embedding IS NOT NULL',
    'size(n.name_embedding) = size($search_vector)'
  ];

  if (groupIds && groupIds.length > 0) {
    queries.push('n.group_id IN $group_ids');
    params.group_ids = groupIds;
  }

  queries.push(...filterQueries);

  return {
    clause: queries.length > 0 ? `WHERE ${queries.join(' AND ')}` : '',
    params
  };
}

function buildNodeBfsWhereClause(
  originNodeUuids: string[],
  searchFilter: SearchFilters,
  groupIds?: string[] | null
): { clause: string; params: Record<string, unknown> } {
  const [filterQueries, filterParams] = nodeSearchFilterQueryConstructor(
    searchFilter,
    GraphProviders.FALKORDB
  );
  const params: Record<string, unknown> = {
    ...filterParams,
    origin_node_uuids: originNodeUuids
  };
  const queries = ['n.uuid <> origin_uuid'];

  if (groupIds && groupIds.length > 0) {
    queries.push('n.group_id IN $group_ids');
    params.group_ids = groupIds;
  }

  queries.push(...filterQueries);

  return {
    clause: queries.length > 0 ? `WHERE ${queries.join(' AND ')}` : '',
    params
  };
}

function buildEdgeSearchWhereClause(
  query: string,
  searchFilter: SearchFilters,
  groupIds?: string[] | null
): { clause: string; params: Record<string, unknown> } {
  const [filterQueries, filterParams] = edgeSearchFilterQueryConstructor(
    searchFilter,
    GraphProviders.FALKORDB
  );
  const params: Record<string, unknown> = {
    ...filterParams,
    query_lower: query.toLowerCase()
  };
  const queries = [
    '(toLower(coalesce(e.name, "")) CONTAINS $query_lower OR toLower(coalesce(e.fact, "")) CONTAINS $query_lower)'
  ];

  if (groupIds && groupIds.length > 0) {
    queries.push('e.group_id IN $group_ids');
    params.group_ids = groupIds;
  }

  queries.push(...filterQueries);

  return {
    clause: queries.length > 0 ? `WHERE ${queries.join(' AND ')}` : '',
    params
  };
}

function buildEdgeVectorWhereClause(
  searchFilter: SearchFilters,
  groupIds?: string[] | null
): { clause: string; params: Record<string, unknown> } {
  const [filterQueries, filterParams] = edgeSearchFilterQueryConstructor(
    searchFilter,
    GraphProviders.FALKORDB
  );
  const params: Record<string, unknown> = { ...filterParams };
  const queries = [
    'e.fact_embedding IS NOT NULL',
    'size(e.fact_embedding) = size($search_vector)'
  ];

  if (groupIds && groupIds.length > 0) {
    queries.push('e.group_id IN $group_ids');
    params.group_ids = groupIds;
  }

  queries.push(...filterQueries);

  return {
    clause: queries.length > 0 ? `WHERE ${queries.join(' AND ')}` : '',
    params
  };
}

function buildEdgeBfsWhereClause(
  originNodeUuids: string[],
  searchFilter: SearchFilters,
  groupIds?: string[] | null
): { clause: string; params: Record<string, unknown> } {
  const [filterQueries, filterParams] = edgeSearchFilterQueryConstructor(
    searchFilter,
    GraphProviders.FALKORDB
  );
  const params: Record<string, unknown> = {
    ...filterParams,
    origin_node_uuids: originNodeUuids
  };
  const queries = ['e.uuid IS NOT NULL'];

  if (groupIds && groupIds.length > 0) {
    queries.push('e.group_id IN $group_ids');
    params.group_ids = groupIds;
  }

  queries.push(...filterQueries);

  return {
    clause: queries.length > 0 ? `WHERE ${queries.join(' AND ')}` : '',
    params
  };
}

function normalizeOriginNodeUuids(
  originNodeUuids: string[] | null | undefined
): string[] {
  if (!originNodeUuids) {
    return [];
  }

  return [...new Set(originNodeUuids.filter((uuid) => uuid.trim() !== ''))];
}

function normalizeMaxDepth(maxDepth: number): number {
  const normalized = Number.isFinite(maxDepth) ? Math.trunc(maxDepth) : 1;
  return normalized > 0 ? normalized : 1;
}

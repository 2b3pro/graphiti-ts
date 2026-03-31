import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type { Graphiti, EntityNode, EntityEdge, EpisodicNode } from '@graphiti/core';
import { NODE_HYBRID_SEARCH_RRF, createSearchFilters } from '@graphiti/core';

import type { McpServerConfig } from './config.js';

export function createGraphitiMcpServer(
  graphiti: Graphiti,
  config: McpServerConfig
): McpServer {
  const server = new McpServer({
    name: 'graphiti',
    version: '1.0.0'
  });

  // ── add_memory ────────────────────────────────────────────────────────────
  server.tool(
    'add_memory',
    'Add an episode to memory. This is the primary way to add information to the graph.',
    {
      name: z.string().describe('Name of the episode'),
      episode_body: z.string().describe('The content of the episode to persist to memory'),
      group_id: z.string().optional().describe('A unique ID for this graph'),
      source: z
        .enum(['text', 'json', 'message'])
        .optional()
        .default('text')
        .describe("Source type: 'text', 'json', or 'message'"),
      source_description: z.string().optional().default('').describe('Description of the source'),
      uuid: z.string().optional().describe('Optional UUID for the episode')
    },
    async ({ name, episode_body, group_id, source, source_description, uuid }) => {
      const effectiveGroupId = group_id ?? config.default_group_id;
      const episode: EpisodicNode = {
        uuid: uuid ?? crypto.randomUUID(),
        name,
        content: episode_body,
        group_id: effectiveGroupId,
        source: (source ?? 'text') as EpisodicNode['source'],
        source_description: source_description ?? '',
        labels: [],
        created_at: new Date(),
        entity_edges: []
      };

      try {
        await graphiti.ingestEpisode({ episode });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Episode '${name}' added successfully to group '${effectiveGroupId}'`
            }
          ]
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error adding episode: ${String(error)}` }],
          isError: true
        };
      }
    }
  );

  // ── search_nodes ──────────────────────────────────────────────────────────
  server.tool(
    'search_nodes',
    'Search for nodes (entities) in the graph memory.',
    {
      query: z.string().describe('The search query'),
      group_ids: z.array(z.string()).optional().describe('Optional list of group IDs to filter'),
      max_nodes: z.number().int().positive().optional().default(10).describe('Max nodes to return'),
      entity_types: z
        .array(z.string())
        .optional()
        .describe('Optional list of entity type labels to filter by')
    },
    async ({ query, group_ids, max_nodes, entity_types }) => {
      const effectiveGroupIds = group_ids ?? [config.default_group_id];
      const searchFilter = createSearchFilters({ node_labels: entity_types ?? null });

      try {
        const results = await graphiti.search(query, NODE_HYBRID_SEARCH_RRF, {
          group_ids: effectiveGroupIds,
          search_filter: searchFilter
        });
        const nodes = results.nodes.slice(0, max_nodes);

        if (nodes.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No relevant nodes found' }] };
        }

        const formatted = nodes.map((node: EntityNode) => ({
          uuid: node.uuid,
          name: node.name,
          labels: node.labels,
          summary: node.summary,
          group_id: node.group_id,
          created_at: node.created_at.toISOString()
        }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error searching nodes: ${String(error)}` }],
          isError: true
        };
      }
    }
  );

  // ── search_memory_facts ───────────────────────────────────────────────────
  server.tool(
    'search_memory_facts',
    'Search the graph memory for relevant facts (edges/relationships).',
    {
      query: z.string().describe('The search query'),
      group_ids: z.array(z.string()).optional().describe('Optional list of group IDs to filter'),
      max_facts: z.number().int().positive().optional().default(10).describe('Max facts to return'),
      center_node_uuid: z
        .string()
        .optional()
        .describe('Optional UUID of a node to center the search around')
    },
    async ({ query, group_ids, max_facts, center_node_uuid }) => {
      const effectiveGroupIds = group_ids ?? [config.default_group_id];

      try {
        const edges = await graphiti.searchEdges(query, {
          group_ids: effectiveGroupIds,
          center_node_uuid: center_node_uuid ?? null,
          num_results: max_facts
        });

        if (edges.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No relevant facts found' }] };
        }

        const formatted = edges.map((edge: EntityEdge) => ({
          uuid: edge.uuid,
          name: edge.name,
          fact: edge.fact,
          source_node_uuid: edge.source_node_uuid,
          target_node_uuid: edge.target_node_uuid,
          group_id: edge.group_id,
          valid_at: edge.valid_at?.toISOString() ?? null,
          invalid_at: edge.invalid_at?.toISOString() ?? null,
          created_at: edge.created_at.toISOString()
        }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error searching facts: ${String(error)}` }],
          isError: true
        };
      }
    }
  );

  // ── delete_entity_edge ────────────────────────────────────────────────────
  server.tool(
    'delete_entity_edge',
    'Delete an entity edge from the graph memory.',
    { uuid: z.string().describe('UUID of the entity edge to delete') },
    async ({ uuid }) => {
      try {
        await graphiti.deleteEntityEdge(uuid);
        return {
          content: [
            { type: 'text' as const, text: `Entity edge with UUID ${uuid} deleted successfully` }
          ]
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: `Error deleting entity edge: ${String(error)}` }
          ],
          isError: true
        };
      }
    }
  );

  // ── delete_episode ────────────────────────────────────────────────────────
  server.tool(
    'delete_episode',
    'Delete an episode from the graph memory.',
    { uuid: z.string().describe('UUID of the episode to delete') },
    async ({ uuid }) => {
      try {
        await graphiti.deleteEpisode(uuid);
        return {
          content: [
            { type: 'text' as const, text: `Episode with UUID ${uuid} deleted successfully` }
          ]
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error deleting episode: ${String(error)}` }],
          isError: true
        };
      }
    }
  );

  // ── get_entity_edge ───────────────────────────────────────────────────────
  server.tool(
    'get_entity_edge',
    'Get an entity edge from the graph memory by its UUID.',
    { uuid: z.string().describe('UUID of the entity edge to retrieve') },
    async ({ uuid }) => {
      try {
        const edge = await graphiti.edges.entity.getByUuid(uuid);
        const formatted = {
          uuid: edge.uuid,
          name: edge.name,
          fact: edge.fact,
          source_node_uuid: edge.source_node_uuid,
          target_node_uuid: edge.target_node_uuid,
          group_id: edge.group_id,
          valid_at: edge.valid_at?.toISOString() ?? null,
          invalid_at: edge.invalid_at?.toISOString() ?? null,
          expired_at: edge.expired_at?.toISOString() ?? null,
          created_at: edge.created_at.toISOString(),
          episodes: edge.episodes
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }]
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: `Error getting entity edge: ${String(error)}` }
          ],
          isError: true
        };
      }
    }
  );

  // ── get_episodes ──────────────────────────────────────────────────────────
  server.tool(
    'get_episodes',
    'Get episodes from the graph memory.',
    {
      group_ids: z.array(z.string()).optional().describe('Optional list of group IDs to filter'),
      max_episodes: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe('Max episodes to return')
    },
    async ({ group_ids, max_episodes }) => {
      const effectiveGroupIds = group_ids ?? [config.default_group_id];

      try {
        const episodes = await graphiti.retrieveEpisodes(effectiveGroupIds, max_episodes);

        if (episodes.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No episodes found' }] };
        }

        const formatted = episodes.map((ep: EpisodicNode) => ({
          uuid: ep.uuid,
          name: ep.name,
          content: ep.content,
          source: ep.source,
          source_description: ep.source_description,
          group_id: ep.group_id,
          created_at: ep.created_at.toISOString(),
          valid_at: ep.valid_at?.toISOString() ?? null
        }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error getting episodes: ${String(error)}` }],
          isError: true
        };
      }
    }
  );

  // ── clear_graph ───────────────────────────────────────────────────────────
  server.tool(
    'clear_graph',
    'Clear all data from the graph for specified group IDs.',
    {
      group_ids: z
        .array(z.string())
        .optional()
        .describe('Optional list of group IDs to clear. Defaults to the configured default group.')
    },
    async ({ group_ids }) => {
      const effectiveGroupIds = group_ids ?? [config.default_group_id];

      if (effectiveGroupIds.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No group IDs specified for clearing' }],
          isError: true
        };
      }

      try {
        await Promise.all(effectiveGroupIds.map((gid) => graphiti.deleteGroup(gid)));
        return {
          content: [
            {
              type: 'text' as const,
              text: `Graph data cleared for group IDs: ${effectiveGroupIds.join(', ')}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error clearing graph: ${String(error)}` }],
          isError: true
        };
      }
    }
  );

  // ── get_status ────────────────────────────────────────────────────────────
  server.tool('get_status', 'Get the status of the Graphiti MCP server.', {}, async () => {
    try {
      await graphiti.driver.executeQuery('RETURN 1 AS ok', { routing: 'r' });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'ok', message: 'Graphiti MCP server is running' })
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'error', message: String(error) })
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

export async function runStdioServer(graphiti: Graphiti, config: McpServerConfig): Promise<void> {
  const server = createGraphitiMcpServer(graphiti, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Create the MCP server and return it for use with any transport.
 * This enables HTTP/SSE transport by letting callers wire their own transport.
 *
 * Usage with StreamableHTTPServerTransport:
 *   import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
 *   const server = createGraphitiMcpServer(graphiti, config);
 *   const transport = new StreamableHTTPServerTransport({ ... });
 *   await server.connect(transport);
 *
 * Usage with SSEServerTransport:
 *   import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
 *   const server = createGraphitiMcpServer(graphiti, config);
 *   const transport = new SSEServerTransport('/messages', res);
 *   await server.connect(transport);
 */
// (createGraphitiMcpServer is already exported above for this purpose)

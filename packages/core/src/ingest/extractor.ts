import { utcNow } from '@graphiti/shared';

import type { LLMClient } from '../contracts';
import type { EntityEdge } from '../domain/edges';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import { MessageRoles, type Message } from '../prompts/types';

export interface EpisodeExtractionContext {
  episode: EpisodicNode;
  previous_episodes: EpisodicNode[];
}

export interface EpisodeExtractionResult {
  entities: EntityNode[];
  entity_edges: EntityEdge[];
}

export interface EpisodeExtractor {
  extract(context: EpisodeExtractionContext): Promise<EpisodeExtractionResult>;
}

export class HeuristicEpisodeExtractor implements EpisodeExtractor {
  async extract(context: EpisodeExtractionContext): Promise<EpisodeExtractionResult> {
    const aliasMap = extractEntityAliases(context.episode.content);
    const aliasLookup = buildAliasLookup(aliasMap);
    const names = extractEntityNames(context.episode.content).map(
      (name) => aliasLookup.get(name) ?? name
    );
    const entityByName = new Map<string, EntityNode>();

    for (const name of names) {
      entityByName.set(
        name,
        mergeEntityAlias(entityByName.get(name), {
          uuid: crypto.randomUUID(),
          name,
          group_id: context.episode.group_id,
          labels: ['Extracted'],
          created_at: utcNow(),
          summary: ''
        })
      );
    }

    for (const [canonicalName, aliases] of aliasMap.entries()) {
      const entity = entityByName.get(canonicalName);
      if (!entity) {
        continue;
      }

      entityByName.set(
        canonicalName,
        mergeEntityAlias(entity, {
          ...entity,
          attributes: {
            ...(entity.attributes ?? {}),
            aliases
          }
        })
      );
    }

    const entities = [...entityByName.values()];
    const entity_edges = extractEntityEdges(
      context.episode.content,
      entityByName,
      context.episode,
      aliasLookup
    );

    return {
      entities,
      entity_edges
    };
  }
}

export class ModelEpisodeExtractor implements EpisodeExtractor {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly fallbackExtractor: EpisodeExtractor = new HeuristicEpisodeExtractor()
  ) {}

  async extract(context: EpisodeExtractionContext): Promise<EpisodeExtractionResult> {
    const messages = buildEpisodeExtractionPrompt(context);

    try {
      const responseText = await this.llmClient.generateText(messages);
      return mapModelExtractionResponse(context, responseText);
    } catch {
      return this.fallbackExtractor.extract(context);
    }
  }
}

const RELATION_PATTERNS: Array<{ pattern: RegExp; relation: string }> = [
  { pattern: /\b([A-Z][a-z]+)\s+knows\s+([A-Z][a-z]+)\b/g, relation: 'knows' },
  { pattern: /\b([A-Z][a-z]+)\s+met\s+([A-Z][a-z]+)\b/g, relation: 'met' },
  {
    pattern: /\b([A-Z][a-z]+)\s+works with\s+([A-Z][a-z]+)\b/g,
    relation: 'works_with'
  },
  { pattern: /\b([A-Z][a-z]+)\s+likes\s+([A-Z][a-z]+)\b/g, relation: 'likes' },
  { pattern: /\b([A-Z][a-z]+)\s+told\s+([A-Z][a-z]+)\b/g, relation: 'told' },
  {
    pattern: /\b([A-Z][a-z]+)\s+mentioned\s+([A-Z][a-z]+)\b/g,
    relation: 'mentioned'
  },
  {
    pattern: /\b([A-Z][a-z]+)\s+greeted\s+([A-Z][a-z]+)\b/g,
    relation: 'greeted'
  }
];

interface ModelExtractionResponse {
  entities?: Array<{
    name?: string;
    labels?: string[];
    summary?: string;
    aliases?: string[];
  }>;
  entity_edges?: Array<{
    source?: string;
    target?: string;
    name?: string;
    fact?: string;
  }>;
}

export function extractEntityNames(content: string): string[] {
  const matches = content.match(/\b[A-Z][a-z]+\b/g) ?? [];
  const names = new Set<string>();

  for (const match of matches) {
    if (COMMON_NON_ENTITY_TOKENS.has(match)) {
      continue;
    }

    names.add(match);
  }

  return [...names];
}

export function extractEntityEdges(
  content: string,
  entityByName: Map<string, EntityNode>,
  episode: EpisodicNode,
  aliasLookup: Map<string, string> = new Map()
): EntityEdge[] {
  const edges: EntityEdge[] = [];

  for (const { pattern, relation } of RELATION_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const sourceName = aliasLookup.get(match[1] ?? '') ?? match[1];
      const targetName = aliasLookup.get(match[2] ?? '') ?? match[2];
      if (!sourceName || !targetName) {
        continue;
      }

      const sourceNode = entityByName.get(sourceName);
      const targetNode = entityByName.get(targetName);
      if (!sourceNode || !targetNode) {
        continue;
      }

      edges.push({
        uuid: crypto.randomUUID(),
        group_id: episode.group_id,
        source_node_uuid: sourceNode.uuid,
        target_node_uuid: targetNode.uuid,
        created_at: episode.created_at,
        name: relation,
        fact: match[0],
        episodes: [episode.uuid]
      });
    }
  }

  return dedupeEdges(edges);
}

function dedupeEdges(edges: EntityEdge[]): EntityEdge[] {
  const seen = new Set<string>();
  const deduped: EntityEdge[] = [];

  for (const edge of edges) {
    const key = `${edge.source_node_uuid}:${edge.name}:${edge.target_node_uuid}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(edge);
  }

  return deduped;
}

export function buildEpisodeExtractionPrompt(context: EpisodeExtractionContext): Message[] {
  return [
    {
      role: MessageRoles.system,
      content:
        'Extract graph entities and relations from the episode. Return strict JSON with keys "entities" and "entity_edges".'
    },
    {
      role: MessageRoles.user,
      content: JSON.stringify({
        instructions: {
          entities:
            'Return canonical entities mentioned in the episode. Each entity must include name and may include labels, summary, and aliases.',
          entity_edges:
            'Return factual directed relations with source, target, name, and fact. Use snake_case relation names.',
          output_shape: {
            entities: [
              {
                name: 'string',
                labels: ['string'],
                summary: 'string',
                aliases: ['string']
              }
            ],
            entity_edges: [
              { source: 'string', target: 'string', name: 'string', fact: 'string' }
            ]
          }
        },
        episode: {
          uuid: context.episode.uuid,
          group_id: context.episode.group_id,
          source: context.episode.source,
          source_description: context.episode.source_description,
          content: context.episode.content
        },
        previous_episodes: context.previous_episodes.slice(0, 5).map((episode) => ({
          uuid: episode.uuid,
          content: episode.content,
          valid_at: episode.valid_at?.toISOString() ?? null
        }))
      })
    }
  ];
}

export function parseModelExtractionResponse(responseText: string): ModelExtractionResponse {
  const trimmed = responseText.trim();
  const withoutCodeFence =
    trimmed.startsWith('```') && trimmed.endsWith('```')
      ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      : trimmed;

  return validateModelExtractionResponse(JSON.parse(withoutCodeFence));
}

export function mapModelExtractionResponse(
  context: EpisodeExtractionContext,
  responseText: string
): EpisodeExtractionResult {
  const parsed = parseModelExtractionResponse(responseText);
  const entityByName = new Map<string, EntityNode>();
  const aliasLookup = new Map<string, string>();

  for (const rawEntity of parsed.entities ?? []) {
    const name = rawEntity.name?.trim() ?? '';
    if (name === '') {
      continue;
    }

    const aliases = sanitizeAliases(rawEntity.aliases, name);
    entityByName.set(
      name,
      mergeEntityAlias(entityByName.get(name), {
        uuid: crypto.randomUUID(),
        name,
        group_id: context.episode.group_id,
        labels: rawEntity.labels?.length ? rawEntity.labels : ['Extracted', 'Model'],
        created_at: utcNow(),
        summary: rawEntity.summary?.trim() ?? '',
        ...(aliases.length === 0 ? {} : { attributes: { aliases } })
      })
    );

    for (const alias of aliases) {
      aliasLookup.set(alias, name);
    }
  }

  for (const rawEdge of parsed.entity_edges ?? []) {
    const sourceName = aliasLookup.get(rawEdge.source?.trim() ?? '') ?? rawEdge.source?.trim() ?? '';
    const targetName = aliasLookup.get(rawEdge.target?.trim() ?? '') ?? rawEdge.target?.trim() ?? '';

    if (sourceName !== '' && !entityByName.has(sourceName)) {
      entityByName.set(sourceName, {
        uuid: crypto.randomUUID(),
        name: sourceName,
        group_id: context.episode.group_id,
        labels: ['Extracted', 'Model'],
        created_at: utcNow(),
        summary: ''
      });
    }

    if (targetName !== '' && !entityByName.has(targetName)) {
      entityByName.set(targetName, {
        uuid: crypto.randomUUID(),
        name: targetName,
        group_id: context.episode.group_id,
        labels: ['Extracted', 'Model'],
        created_at: utcNow(),
        summary: ''
      });
    }
  }

  const entity_edges: EntityEdge[] = [];

  for (const rawEdge of parsed.entity_edges ?? []) {
    const sourceName =
      aliasLookup.get(rawEdge.source?.trim() ?? '') ?? rawEdge.source?.trim() ?? '';
    const targetName =
      aliasLookup.get(rawEdge.target?.trim() ?? '') ?? rawEdge.target?.trim() ?? '';
    const relationName = normalizeRelationName(rawEdge.name?.trim() ?? '');
    const fact = rawEdge.fact?.trim() ?? '';
    const sourceNode = entityByName.get(sourceName);
    const targetNode = entityByName.get(targetName);

    if (!sourceNode || !targetNode || relationName === '' || fact === '') {
      continue;
    }

    entity_edges.push({
      uuid: crypto.randomUUID(),
      group_id: context.episode.group_id,
      source_node_uuid: sourceNode.uuid,
      target_node_uuid: targetNode.uuid,
      created_at: context.episode.created_at,
      name: relationName,
      fact,
      episodes: [context.episode.uuid]
    });
  }

  return {
    entities: [...entityByName.values()],
    entity_edges: dedupeEdges(entity_edges)
  };
}

function normalizeRelationName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function validateModelExtractionResponse(value: unknown): ModelExtractionResponse {
  if (!isPlainObject(value)) {
    throw new Error('Model extraction response must be an object');
  }

  const entities = validateExtractionEntities(value.entities);
  const entityEdges = validateExtractionEdges(value.entity_edges);

  return {
    ...(entities === undefined ? {} : { entities }),
    ...(entityEdges === undefined ? {} : { entity_edges: entityEdges })
  };
}

function validateExtractionEntities(value: unknown): ModelExtractionResponse['entities'] {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('Model extraction entities must be an array');
  }

  return value.map((entity) => {
    if (!isPlainObject(entity)) {
      throw new Error('Model extraction entity must be an object');
    }

    if (entity.name !== undefined && typeof entity.name !== 'string') {
      throw new Error('Model extraction entity.name must be a string');
    }

    if (entity.summary !== undefined && typeof entity.summary !== 'string') {
      throw new Error('Model extraction entity.summary must be a string');
    }

    if (
      entity.labels !== undefined &&
      (!Array.isArray(entity.labels) || !entity.labels.every((label) => typeof label === 'string'))
    ) {
      throw new Error('Model extraction entity.labels must be a string array');
    }

    if (
      entity.aliases !== undefined &&
      (!Array.isArray(entity.aliases) ||
        !entity.aliases.every((alias) => typeof alias === 'string'))
    ) {
      throw new Error('Model extraction entity.aliases must be a string array');
    }

    return {
      ...(typeof entity.name === 'string' ? { name: entity.name } : {}),
      ...(Array.isArray(entity.labels) ? { labels: entity.labels } : {}),
      ...(typeof entity.summary === 'string' ? { summary: entity.summary } : {}),
      ...(Array.isArray(entity.aliases) ? { aliases: entity.aliases } : {})
    };
  });
}

function validateExtractionEdges(value: unknown): ModelExtractionResponse['entity_edges'] {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('Model extraction entity_edges must be an array');
  }

  return value.map((edge) => {
    if (!isPlainObject(edge)) {
      throw new Error('Model extraction edge must be an object');
    }

    if (edge.source !== undefined && typeof edge.source !== 'string') {
      throw new Error('Model extraction edge.source must be a string');
    }

    if (edge.target !== undefined && typeof edge.target !== 'string') {
      throw new Error('Model extraction edge.target must be a string');
    }

    if (edge.name !== undefined && typeof edge.name !== 'string') {
      throw new Error('Model extraction edge.name must be a string');
    }

    if (edge.fact !== undefined && typeof edge.fact !== 'string') {
      throw new Error('Model extraction edge.fact must be a string');
    }

    return {
      ...(typeof edge.source === 'string' ? { source: edge.source } : {}),
      ...(typeof edge.target === 'string' ? { target: edge.target } : {}),
      ...(typeof edge.name === 'string' ? { name: edge.name } : {}),
      ...(typeof edge.fact === 'string' ? { fact: edge.fact } : {})
    };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractEntityAliases(content: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();

  for (const { pattern, canonicalIndex, aliasIndex } of ALIAS_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const canonicalName = match[canonicalIndex]?.trim();
      const alias = match[aliasIndex]?.trim();
      if (!canonicalName || !alias) {
        continue;
      }

      const existing = aliases.get(canonicalName) ?? [];
      existing.push(alias);
      aliases.set(canonicalName, sanitizeAliases(existing, canonicalName));
    }
  }

  return aliases;
}

function buildAliasLookup(aliasMap: Map<string, string[]>): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const [canonicalName, aliases] of aliasMap.entries()) {
    for (const alias of aliases) {
      lookup.set(alias, canonicalName);
    }
  }

  return lookup;
}

function sanitizeAliases(aliases: string[] | undefined, canonicalName: string): string[] {
  return [...new Set((aliases ?? []).map((alias) => alias.trim()).filter((alias) => {
    return alias !== '' && alias.toLowerCase() !== canonicalName.trim().toLowerCase();
  }))];
}

function mergeEntityAlias(existing: EntityNode | undefined, incoming: EntityNode): EntityNode {
  if (!existing) {
    return incoming;
  }

  const mergedAliases = sanitizeAliases(
    [...getEntityAliases(existing), ...getEntityAliases(incoming)],
    existing.name
  );

  return {
    ...existing,
    labels: [...new Set([...existing.labels, ...incoming.labels])],
    summary: existing.summary || incoming.summary,
    ...((incoming.attributes ?? existing.attributes)
      ? {
          attributes: {
            ...(existing.attributes ?? {}),
            ...(incoming.attributes ?? {}),
            ...(mergedAliases.length === 0 ? {} : { aliases: mergedAliases })
          }
        }
      : {})
  };
}

function getEntityAliases(entity: EntityNode): string[] {
  const aliases = entity.attributes?.aliases;
  return Array.isArray(aliases) && aliases.every((value) => typeof value === 'string')
    ? aliases
    : [];
}

const COMMON_NON_ENTITY_TOKENS = new Set([
  'The',
  'A',
  'An',
  'And',
  'But',
  'Or',
  'If',
  'Then',
  'When',
  'While',
  'Later',
  'Today',
  'Yesterday',
  'Tomorrow'
]);

const ALIAS_PATTERNS: Array<{
  pattern: RegExp;
  canonicalIndex: number;
  aliasIndex: number;
}> = [
  {
    pattern:
      /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s*,\s*(?:also known as|known as|aka)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\b/g,
    canonicalIndex: 1,
    aliasIndex: 2
  },
  {
    pattern:
      /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+\((?:also known as|known as|aka)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\)/g,
    canonicalIndex: 1,
    aliasIndex: 2
  }
];

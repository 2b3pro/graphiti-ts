import type { LLMClient } from '../contracts';
import type { EntityAttributes } from '../domain/common';
import type { EntityNode, EpisodicNode } from '../domain/nodes';
import type { EntityEdge } from '../domain/edges';
import { MessageRoles, type Message } from '../prompts/types';

export interface NodeHydrationContext {
  episode: EpisodicNode;
  previous_episodes: EpisodicNode[];
  entities: EntityNode[];
  entity_edges: EntityEdge[];
}

export interface NodeHydrator {
  hydrate(context: NodeHydrationContext): Promise<EntityNode[]>;
}

export class HeuristicNodeHydrator implements NodeHydrator {
  async hydrate(context: NodeHydrationContext): Promise<EntityNode[]> {
    const sentences = splitIntoSentences(context.episode.content);
    const currentSeenAt = context.episode.valid_at ?? context.episode.created_at;

    return context.entities.map((entity) => {
      const relatedSentences = sentences.filter((sentence) => sentence.includes(entity.name));
      const derivedSummary =
        relatedSentences.length > 0
          ? relatedSentences.slice(0, 2).join(' ').slice(0, 280)
          : entity.summary;
      const outgoingEdgeCount = context.entity_edges.filter(
        (edge) => edge.source_node_uuid === entity.uuid || edge.target_node_uuid === entity.uuid
      ).length;
      const existingAttributes = entity.attributes ?? {};
      const previousMentionCount = getNumericAttribute(existingAttributes.mention_count);
      const previousEdgeCount = getNumericAttribute(existingAttributes.edge_count);
      const previousFirstSeenAt = parseAttributeDate(existingAttributes.first_seen_at);
      const previousLastSeenAt = parseAttributeDate(existingAttributes.last_seen_at);
      const currentSourceDescription = context.episode.source_description;
      const latestSourceDescription =
        previousLastSeenAt && previousLastSeenAt.getTime() > currentSeenAt.getTime()
          ? getOptionalStringAttribute(existingAttributes.source_description) ??
            currentSourceDescription
          : currentSourceDescription;

      return {
        ...entity,
        summary: entity.summary || derivedSummary,
        attributes: {
          ...existingAttributes,
          source_description: latestSourceDescription,
          source_descriptions: mergeSourceDescriptions(existingAttributes, currentSourceDescription),
          mention_count: previousMentionCount + relatedSentences.length,
          edge_count: Math.max(previousEdgeCount, outgoingEdgeCount),
          first_seen_at: minDate(previousFirstSeenAt, currentSeenAt).toISOString(),
          last_seen_at: maxDate(previousLastSeenAt, currentSeenAt).toISOString()
        }
      };
    });
  }
}

export class ModelNodeHydrator implements NodeHydrator {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly fallbackHydrator: NodeHydrator = new HeuristicNodeHydrator()
  ) {}

  async hydrate(context: NodeHydrationContext): Promise<EntityNode[]> {
    const baseline = await this.fallbackHydrator.hydrate(context);
    const messages = buildNodeHydrationPrompt(context);
    const currentSeenAt = context.episode.valid_at ?? context.episode.created_at;

    try {
      const responseText = await this.llmClient.generateText(messages);
      return mapModelHydrationResponse(baseline, responseText, currentSeenAt);
    } catch {
      return baseline;
    }
  }
}

interface ModelHydrationResponse {
  entities?: Array<{
    uuid?: string;
    name?: string;
    summary?: string;
    attributes?: Record<string, unknown>;
  }>;
}

export function splitIntoSentences(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

export function buildNodeHydrationPrompt(context: NodeHydrationContext): Message[] {
  return [
    {
      role: MessageRoles.system,
      content:
        'Enrich graph entities from the episode context. Return strict JSON with key "entities". Each entity may include uuid, name, summary, and attributes.'
    },
    {
      role: MessageRoles.user,
      content: JSON.stringify({
        instructions: {
          goal:
            'Improve entity summaries and attributes using the current episode, previous episodes, and extracted relations.',
          output_shape: {
            entities: [
              {
                uuid: 'string',
                name: 'string',
                summary: 'string',
                attributes: { any: 'json' }
              }
            ]
          }
        },
        episode: {
          uuid: context.episode.uuid,
          source_description: context.episode.source_description,
          content: context.episode.content,
          valid_at: context.episode.valid_at?.toISOString() ?? null
        },
        entities: context.entities.map((entity) => ({
          uuid: entity.uuid,
          name: entity.name,
          summary: entity.summary,
          attributes: entity.attributes ?? {}
        })),
        entity_edges: context.entity_edges.map((edge) => ({
          uuid: edge.uuid,
          source_node_uuid: edge.source_node_uuid,
          target_node_uuid: edge.target_node_uuid,
          name: edge.name,
          fact: edge.fact
        })),
        previous_episodes: context.previous_episodes.slice(0, 5).map((episode) => ({
          uuid: episode.uuid,
          content: episode.content,
          valid_at: episode.valid_at?.toISOString() ?? null
        }))
      })
    }
  ];
}

export function parseModelHydrationResponse(responseText: string): ModelHydrationResponse {
  const trimmed = responseText.trim();
  const withoutCodeFence =
    trimmed.startsWith('```') && trimmed.endsWith('```')
      ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      : trimmed;

  return validateModelHydrationResponse(JSON.parse(withoutCodeFence));
}

export function mapModelHydrationResponse(
  baseline: EntityNode[],
  responseText: string,
  currentSeenAt?: Date
): EntityNode[] {
  const parsed = parseModelHydrationResponse(responseText);
  const byUuid = new Map(
    (parsed.entities ?? [])
      .filter((entity) => (entity.uuid?.trim() ?? '') !== '')
      .map((entity) => [entity.uuid!.trim(), entity] as const)
  );
  const byName = new Map(
    (parsed.entities ?? [])
      .filter((entity) => (entity.name?.trim() ?? '') !== '')
      .map((entity) => [entity.name!.trim(), entity] as const)
  );

  return baseline.map((entity) => {
    const modelEntity = byUuid.get(entity.uuid) ?? byName.get(entity.name);
    if (!modelEntity) {
      return entity;
    }

    const summary = modelEntity.summary?.trim() ?? '';

    return {
      ...entity,
      summary: summary === '' ? entity.summary : summary,
      attributes: mergeEntityAttributes(
        entity.attributes,
        sanitizeAttributes(modelEntity.attributes),
        {
          preferIncomingStrings: shouldPreferIncomingStringAttributes(entity.attributes, currentSeenAt),
          ...(currentSeenAt ? { currentSeenAt } : {})
        }
      )
    };
  });
}

function sanitizeAttributes(attributes: Record<string, unknown> | undefined): EntityAttributes {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    return {};
  }

  const sanitized: EntityAttributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) ||
      (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) ||
      (Array.isArray(value) && value.every((entry) => typeof entry === 'boolean'))
    ) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function mergeEntityAttributes(
  existing: EntityAttributes | undefined,
  incoming: EntityAttributes,
  options: { preferIncomingStrings?: boolean; currentSeenAt?: Date } = {}
): EntityAttributes {
  const merged: EntityAttributes = {
    ...(existing ?? {})
  };

  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) {
      continue;
    }

    const existingValue = merged[key];
    if (shouldMergeAsStringSet(key, existingValue, value)) {
      merged[key] = dedupeStringArray([
        ...coerceStringSet(existingValue),
        ...coerceStringSet(value)
      ]);
      continue;
    }

    if (isStringArray(existingValue) && isStringArray(value)) {
      merged[key] = dedupePrimitiveArray([...existingValue, ...value]);
      continue;
    }

    if (isNumberArray(existingValue) && isNumberArray(value)) {
      merged[key] = dedupePrimitiveArray([...existingValue, ...value]);
      continue;
    }

    if (isBooleanArray(existingValue) && isBooleanArray(value)) {
      merged[key] = dedupePrimitiveArray([...existingValue, ...value]);
      continue;
    }

    if (shouldTrackStringHistory(key, existingValue, value)) {
      const historyKey = `${key}_history`;
      const previousValue = existingValue as string;
      const nextValue = typeof value === 'string' ? value : previousValue;
      const shouldReplaceCurrent = options.preferIncomingStrings !== false;
      merged[historyKey] = dedupeStringArray([
        ...getStringArrayAttribute(merged[historyKey]),
        previousValue,
        nextValue
      ]);
      merged[key] = shouldReplaceCurrent ? nextValue : previousValue;
      setTemporalStringMetadata(
        merged,
        key,
        shouldReplaceCurrent,
        options.currentSeenAt,
        nextValue
      );
      continue;
    }

    merged[key] = value;
    setTemporalStringMetadata(
      merged,
      key,
      true,
      options.currentSeenAt,
      typeof value === 'string' ? value : null
    );
  }

  return merged;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

function isBooleanArray(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'boolean');
}

function dedupePrimitiveArray<T extends string | number | boolean>(values: T[]): T[] {
  return [...new Set(values)];
}

function dedupeStringArray(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeSourceDescriptions(
  attributes: EntityAttributes,
  sourceDescription: string
): string[] {
  return dedupePrimitiveArray([
    ...getStringArrayAttribute(attributes.source_descriptions),
    ...getOptionalStringArrayAttribute(attributes.source_description),
    sourceDescription
  ]);
}

function getNumericAttribute(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function getOptionalStringAttribute(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  return value;
}

function getOptionalStringArrayAttribute(value: unknown): string[] {
  const attribute = getOptionalStringAttribute(value);
  return attribute ? [attribute] : [];
}

function getStringArrayAttribute(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : [];
}

function coerceStringSet(value: unknown): string[] {
  if (typeof value === 'string' && value.trim() !== '') {
    return [value];
  }

  return getStringArrayAttribute(value);
}

function shouldTrackStringHistory(
  key: string,
  existingValue: unknown,
  incomingValue: unknown
): existingValue is string {
  const policy = getAttributePolicy(key);

  return (
    typeof existingValue === 'string' &&
    existingValue.trim() !== '' &&
    typeof incomingValue === 'string' &&
    incomingValue.trim() !== '' &&
    existingValue !== incomingValue &&
    policy !== 'non_historical' &&
    !key.endsWith('_history')
  );
}

function shouldMergeAsStringSet(key: string, existingValue: unknown, incomingValue: unknown): boolean {
  if (getAttributePolicy(key) !== 'string_set') {
    return false;
  }

  const existingSet = coerceStringSet(existingValue);
  const incomingSet = coerceStringSet(incomingValue);

  return existingSet.length > 0 || incomingSet.length > 0;
}

function setTemporalStringMetadata(
  attributes: EntityAttributes,
  key: string,
  isCurrentValue: boolean,
  currentSeenAt: Date | undefined,
  incomingValue: string | null = null
): void {
  if (getAttributePolicy(key) !== 'temporal_historical_string' || !currentSeenAt) {
    return;
  }

  const updatedAtKey = `${key}_updated_at`;
  const existingUpdatedAt =
    parseAttributeDate(attributes[updatedAtKey]) ?? parseAttributeDate(attributes.last_seen_at);
  const nextUpdatedAt =
    isCurrentValue && incomingValue !== null
      ? maxDate(existingUpdatedAt, currentSeenAt)
      : existingUpdatedAt;

  if (nextUpdatedAt) {
    attributes[updatedAtKey] = nextUpdatedAt.toISOString();
  }
}

function shouldPreferIncomingStringAttributes(
  attributes: EntityAttributes | undefined,
  currentSeenAt: Date | undefined
): boolean {
  if (!currentSeenAt || !attributes) {
    return true;
  }

  const knownLastSeenAt = parseAttributeDate(attributes.last_seen_at);
  if (!knownLastSeenAt) {
    return true;
  }

  return currentSeenAt.getTime() >= knownLastSeenAt.getTime();
}

function parseAttributeDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function minDate(left: Date | null, right: Date): Date {
  if (!left) {
    return right;
  }

  return left.getTime() <= right.getTime() ? left : right;
}

function maxDate(left: Date | null, right: Date): Date {
  if (!left) {
    return right;
  }

  return left.getTime() >= right.getTime() ? left : right;
}

function validateModelHydrationResponse(value: unknown): ModelHydrationResponse {
  if (!isPlainObject(value)) {
    throw new Error('Model hydration response must be an object');
  }

  const entities = value.entities;
  if (entities === undefined) {
    return {};
  }

  if (!Array.isArray(entities)) {
    throw new Error('Model hydration entities must be an array');
  }

  return {
    entities: entities.map((entity) => {
      if (!isPlainObject(entity)) {
        throw new Error('Model hydration entity must be an object');
      }

      if (entity.uuid !== undefined && typeof entity.uuid !== 'string') {
        throw new Error('Model hydration entity.uuid must be a string');
      }

      if (entity.name !== undefined && typeof entity.name !== 'string') {
        throw new Error('Model hydration entity.name must be a string');
      }

      if (entity.summary !== undefined && typeof entity.summary !== 'string') {
        throw new Error('Model hydration entity.summary must be a string');
      }

      if (entity.attributes !== undefined && !isPlainObject(entity.attributes)) {
        throw new Error('Model hydration entity.attributes must be an object');
      }

      return {
        ...(typeof entity.uuid === 'string' ? { uuid: entity.uuid } : {}),
        ...(typeof entity.name === 'string' ? { name: entity.name } : {}),
        ...(typeof entity.summary === 'string' ? { summary: entity.summary } : {}),
        ...(isPlainObject(entity.attributes) ? { attributes: entity.attributes } : {})
      };
    })
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type AttributePolicy =
  | 'default'
  | 'non_historical'
  | 'string_set'
  | 'temporal_historical_string';

const ATTRIBUTE_POLICIES: Record<string, AttributePolicy> = {
  source_description: 'non_historical',
  first_seen_at: 'non_historical',
  last_seen_at: 'non_historical',
  aliases: 'string_set',
  skills: 'string_set',
  teams: 'string_set',
  tags: 'string_set',
  role: 'temporal_historical_string',
  title: 'temporal_historical_string',
  status: 'temporal_historical_string',
  location: 'temporal_historical_string',
  company: 'temporal_historical_string',
  department: 'temporal_historical_string'
};

function getAttributePolicy(key: string): AttributePolicy {
  return ATTRIBUTE_POLICIES[key] ?? 'default';
}

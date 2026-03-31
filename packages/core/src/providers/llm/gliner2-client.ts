/**
 * GLiNER2 client — port of Python's gliner2_client.py.
 *
 * GLiNER2 is a lightweight entity extraction model. This TS port calls a REST
 * API endpoint serving the model (e.g., via FastAPI wrapper or GLiNER2 API).
 *
 * For entity extraction operations, this client calls the GLiNER2 service.
 * For all other operations (dedup, summarization, etc.), it delegates to a
 * general-purpose LLM client.
 */

import type { GenerateResponseOptions, LLMClient } from '../../contracts';
import type { Tracer } from '../../tracing';
import { NoOpTracer } from '../../tracing';
import type { LLMConfig } from '../../llm/config';
import { createLLMConfig } from '../../llm/config';
import type { Message } from '../../prompts/types';
import { generateResponse, type GenerateResponseContext } from '../../llm/generate-response';
import { RateLimitError } from '../errors';

const DEFAULT_ENDPOINT = 'http://localhost:8080/extract';
const DEFAULT_THRESHOLD = 0.5;

export interface GLiNER2ClientOptions {
  config?: Partial<LLMConfig>;
  endpoint?: string;
  threshold?: number;
  /** Required: fallback LLM for non-extraction operations */
  llm_client: LLMClient;
}

export class GLiNER2Client implements LLMClient {
  readonly model: string;
  readonly small_model: string;
  private readonly endpoint: string;
  private readonly threshold: number;
  private readonly llmClient: LLMClient;
  private tracer: Tracer;

  constructor(options: GLiNER2ClientOptions) {
    const config = createLLMConfig(options.config);
    this.model = config.model ?? 'gliner2-base-v1';
    this.small_model = config.small_model ?? this.model;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.llmClient = options.llm_client;
    this.tracer = new NoOpTracer();
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
    this.llmClient.setTracer(tracer);
  }

  async generateText(messages: Message[]): Promise<string> {
    // Check if this looks like an entity extraction request
    const userContent = messages[messages.length - 1]?.content ?? '';
    const isExtraction =
      userContent.includes('extracted_entities') ||
      userContent.includes('ENTITY TYPES') ||
      userContent.includes('Extract all significant entities');

    if (!isExtraction) {
      // Delegate non-extraction to the fallback LLM
      return this.llmClient.generateText(messages);
    }

    const scope = this.tracer.startSpan('llm.generate');

    try {
      scope.span.addAttributes({
        'llm.provider': 'gliner2',
        'llm.model': this.model
      });

      // Extract text content from messages
      const text = extractTextFromMessages(messages);
      const entityLabels = extractEntityLabels(messages);

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          labels: entityLabels,
          threshold: this.threshold
        })
      });

      if (!response.ok) {
        const status = response.status;
        if (status === 429) {
          throw new RateLimitError('GLiNER2 API rate limit');
        }
        throw new Error(`GLiNER2 request failed: ${status} ${response.statusText}`);
      }

      const data = (await response.json()) as {
        entities?: Record<string, Array<{ text: string }>>;
      };

      // Map GLiNER2 output to ExtractedEntities format
      const extractedEntities: Array<{ name: string; entity_type_id: number }> = [];
      const entities = data.entities ?? {};
      const labelToId = buildLabelToIdMap(messages);

      for (const [entityType, items] of Object.entries(entities)) {
        const typeId = labelToId.get(entityType) ?? 0;
        for (const item of items) {
          if (item.text) {
            extractedEntities.push({ name: item.text, entity_type_id: typeId });
          }
        }
      }

      scope.span.setStatus('ok');
      return JSON.stringify({ extracted_entities: extractedEntities });
    } catch (error) {
      scope.span.setStatus('error');
      throw error;
    } finally {
      scope.close();
    }
  }

  async generateResponse(
    messages: Message[],
    options?: GenerateResponseOptions,
    context?: GenerateResponseContext
  ): Promise<Record<string, unknown>> {
    return generateResponse(this, messages, options, context);
  }
}

function extractTextFromMessages(messages: Message[]): string {
  const userContent = messages[messages.length - 1]?.content ?? '';

  // Try known tags in priority order
  for (const tag of ['CURRENT MESSAGE', 'CURRENT_MESSAGE', 'TEXT', 'JSON']) {
    const pattern = new RegExp(`${tag}:\\s*([\\s\\S]*?)(?=\\n[A-Z]|$)`);
    const match = userContent.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return userContent;
}

function extractEntityLabels(messages: Message[]): Record<string, string> {
  const userContent = messages[messages.length - 1]?.content ?? '';
  const match = userContent.match(/ENTITY TYPES:\s*([\s\S]*?)(?=\n\n|\nPREVIOUS|\nCURRENT|\nTEXT|\nJSON|$)/);

  if (match?.[1]) {
    try {
      const types = JSON.parse(match[1]) as Array<{
        entity_type_name: string;
        entity_type_description?: string;
      }>;
      const labels: Record<string, string> = {};
      for (const t of types) {
        labels[t.entity_type_name] = t.entity_type_description ?? '';
      }
      return labels;
    } catch {
      // Not valid JSON
    }
  }

  return { Entity: 'General entity' };
}

function buildLabelToIdMap(messages: Message[]): Map<string, number> {
  const userContent = messages[messages.length - 1]?.content ?? '';
  const match = userContent.match(/ENTITY TYPES:\s*([\s\S]*?)(?=\n\n|\nPREVIOUS|\nCURRENT|\nTEXT|\nJSON|$)/);
  const map = new Map<string, number>();

  if (match?.[1]) {
    try {
      const types = JSON.parse(match[1]) as Array<{
        entity_type_name: string;
        entity_type_id: number;
      }>;
      for (const t of types) {
        map.set(t.entity_type_name, t.entity_type_id);
      }
    } catch {
      // Not valid JSON
    }
  }

  return map;
}

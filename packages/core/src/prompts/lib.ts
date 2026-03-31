/**
 * Prompt library — port of Python's graphiti_core/prompts/lib.py.
 *
 * Centralized registry that aggregates all prompt modules.
 */

import type { PromptFunction } from './types';
import { extractMessage, extractJson, extractText, classifyNodes, extractAttributes, extractSummary, extractSummariesBatch } from './extract-nodes';
import { extractEdges, extractEdgeAttributes } from './extract-edges';
import { dedupeNode, dedupeNodes, dedupeNodeList } from './dedupe-nodes';
import { resolveEdge } from './dedupe-edges';
import { summarizePair, summarizeContext, summaryDescription } from './summarize-nodes';
import { queryExpansion, qaPrompt, evalPrompt, evalAddEpisodeResults } from './eval';

export interface ExtractNodesPrompts {
  extractMessage: PromptFunction;
  extractJson: PromptFunction;
  extractText: PromptFunction;
  classifyNodes: PromptFunction;
  extractAttributes: PromptFunction;
  extractSummary: PromptFunction;
  extractSummariesBatch: PromptFunction;
}

export interface ExtractEdgesPrompts {
  extractEdges: PromptFunction;
  extractEdgeAttributes: PromptFunction;
}

export interface DedupeNodesPrompts {
  dedupeNode: PromptFunction;
  dedupeNodes: PromptFunction;
  dedupeNodeList: PromptFunction;
}

export interface DedupeEdgesPrompts {
  resolveEdge: PromptFunction;
}

export interface SummarizeNodesPrompts {
  summarizePair: PromptFunction;
  summarizeContext: PromptFunction;
  summaryDescription: PromptFunction;
}

export interface EvalPrompts {
  queryExpansion: PromptFunction;
  qaPrompt: PromptFunction;
  evalPrompt: PromptFunction;
  evalAddEpisodeResults: PromptFunction;
}

export interface PromptLibrary {
  extractNodes: ExtractNodesPrompts;
  extractEdges: ExtractEdgesPrompts;
  dedupeNodes: DedupeNodesPrompts;
  dedupeEdges: DedupeEdgesPrompts;
  summarizeNodes: SummarizeNodesPrompts;
  eval: EvalPrompts;
}

export const promptLibrary: PromptLibrary = {
  extractNodes: {
    extractMessage,
    extractJson,
    extractText,
    classifyNodes,
    extractAttributes,
    extractSummary,
    extractSummariesBatch
  },
  extractEdges: {
    extractEdges,
    extractEdgeAttributes
  },
  dedupeNodes: {
    dedupeNode,
    dedupeNodes,
    dedupeNodeList
  },
  dedupeEdges: {
    resolveEdge
  },
  summarizeNodes: {
    summarizePair,
    summarizeContext,
    summaryDescription
  },
  eval: {
    queryExpansion,
    qaPrompt,
    evalPrompt,
    evalAddEpisodeResults
  }
};

import { describe, expect, test } from 'bun:test';

import { promptLibrary } from './lib';
import type { Message } from './types';

/**
 * Validates that a prompt function returns a well-formed Message array:
 * - Non-empty array
 * - Each message has role and content strings
 * - First message is typically system role
 */
function assertValidMessages(messages: Message[]): void {
  expect(messages.length).toBeGreaterThan(0);
  for (const msg of messages) {
    expect(typeof msg.role).toBe('string');
    expect(msg.role.length).toBeGreaterThan(0);
    expect(typeof msg.content).toBe('string');
    expect(msg.content.length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// extractNodes prompts
// ---------------------------------------------------------------------------

describe('extractNodes prompts', () => {
  const baseContext = {
    entity_types: JSON.stringify([{ entity_type_id: 0, entity_type_name: 'Entity' }]),
    current_message: 'Alice met Bob at the coffee shop.',
    previous_messages: 'None',
    previous_episodes: [],
    episode_content: 'Alice met Bob at the coffee shop.',
    episode_timestamp: '2024-01-15T10:00:00Z',
    source_description: 'test',
    content: 'Alice met Bob at the coffee shop.',
    custom_extraction_instructions: ''
  };

  test('extractMessage returns valid messages', () => {
    const msgs = promptLibrary.extractNodes.extractMessage(baseContext);
    assertValidMessages(msgs);
    expect(msgs[0]!.role).toBe('system');
  });

  test('extractJson returns valid messages', () => {
    const msgs = promptLibrary.extractNodes.extractJson({
      ...baseContext,
      content: '{"name": "Alice", "role": "engineer"}'
    });
    assertValidMessages(msgs);
  });

  test('extractText returns valid messages', () => {
    const msgs = promptLibrary.extractNodes.extractText(baseContext);
    assertValidMessages(msgs);
  });

  test('extractMessage injects entity_types into content', () => {
    const msgs = promptLibrary.extractNodes.extractMessage(baseContext);
    const allContent = msgs.map((m) => m.content).join(' ');
    expect(allContent).toContain('Entity');
  });

  test('extractMessage injects current_message', () => {
    const msgs = promptLibrary.extractNodes.extractMessage(baseContext);
    const allContent = msgs.map((m) => m.content).join(' ');
    expect(allContent).toContain('Alice met Bob');
  });

  test('extractAttributes returns valid messages', () => {
    const msgs = promptLibrary.extractNodes.extractAttributes({
      node: { name: 'Alice', entity_types: ['Person'], attributes: {} },
      episode_content: 'Alice is 30 years old.',
      previous_episodes: []
    });
    assertValidMessages(msgs);
  });

  test('extractSummary returns valid messages', () => {
    const msgs = promptLibrary.extractNodes.extractSummary({
      entity: { name: 'Alice', summary: 'Software engineer' },
      episode_content: 'Alice joined Acme Corp.'
    });
    assertValidMessages(msgs);
  });

  test('extractSummariesBatch returns valid messages', () => {
    const msgs = promptLibrary.extractNodes.extractSummariesBatch({
      entities: JSON.stringify([{ name: 'Alice', summary: '', entity_types: ['Person'] }]),
      episode_content: 'Alice is a developer.',
      previous_episodes: []
    });
    assertValidMessages(msgs);
  });

  test('handles null/undefined context fields gracefully', () => {
    const msgs = promptLibrary.extractNodes.extractMessage({});
    assertValidMessages(msgs);
  });
});

// ---------------------------------------------------------------------------
// extractEdges prompts
// ---------------------------------------------------------------------------

describe('extractEdges prompts', () => {
  test('extractEdges returns valid messages', () => {
    const msgs = promptLibrary.extractEdges.extractEdges({
      current_message: 'Alice works at Acme Corp.',
      previous_messages: '',
      entities: JSON.stringify([{ name: 'Alice' }, { name: 'Acme Corp' }]),
      reference_time: '2024-01-15T10:00:00Z'
    });
    assertValidMessages(msgs);
    const allContent = msgs.map((m) => m.content).join(' ');
    expect(allContent).toContain('Alice works at Acme');
  });

  test('extractEdges includes fact_types when provided', () => {
    const msgs = promptLibrary.extractEdges.extractEdges({
      current_message: 'Alice works at Acme.',
      previous_messages: '',
      entities: '[]',
      reference_time: '2024-01-15T10:00:00Z',
      fact_types: JSON.stringify([{ name: 'WORKS_AT' }])
    });
    const allContent = msgs.map((m) => m.content).join(' ');
    expect(allContent).toContain('WORKS_AT');
  });

  test('extractEdgeAttributes returns valid messages', () => {
    const msgs = promptLibrary.extractEdges.extractEdgeAttributes({
      fact: 'Alice works at Acme.',
      reference_time: '2024-01-15T10:00:00Z',
      existing_attributes: '{}'
    });
    assertValidMessages(msgs);
  });

  test('handles empty context', () => {
    const msgs = promptLibrary.extractEdges.extractEdges({});
    assertValidMessages(msgs);
  });
});

// ---------------------------------------------------------------------------
// dedupeNodes prompts
// ---------------------------------------------------------------------------

describe('dedupeNodes prompts', () => {
  test('dedupeNode returns valid messages', () => {
    const msgs = promptLibrary.dedupeNodes.dedupeNode({
      new_entity: 'Alice Johnson',
      existing_entities: JSON.stringify([{ name: 'Alice J.' }]),
      current_message: 'Alice Johnson is here.',
      previous_messages: ''
    });
    assertValidMessages(msgs);
  });

  test('dedupeNodes returns valid messages for batch', () => {
    const msgs = promptLibrary.dedupeNodes.dedupeNodes({
      entities: JSON.stringify([{ id: 0, name: 'Alice' }]),
      existing_entities: JSON.stringify([{ name: 'Alice J.' }]),
      current_message: 'Alice is here.',
      previous_messages: ''
    });
    assertValidMessages(msgs);
  });

  test('dedupeNodeList returns valid messages', () => {
    const msgs = promptLibrary.dedupeNodes.dedupeNodeList({
      entity_list: JSON.stringify([{ name: 'Alice' }, { name: 'Alice J.' }])
    });
    assertValidMessages(msgs);
  });
});

// ---------------------------------------------------------------------------
// dedupeEdges prompts
// ---------------------------------------------------------------------------

describe('dedupeEdges prompts', () => {
  test('resolveEdge returns valid messages', () => {
    const msgs = promptLibrary.dedupeEdges.resolveEdge({
      existing_facts: JSON.stringify([{ idx: 0, fact: 'Alice works at Acme' }]),
      invalidation_candidates: '[]',
      new_fact: 'Alice is employed by Acme Corp'
    });
    assertValidMessages(msgs);
    const allContent = msgs.map((m) => m.content).join(' ');
    expect(allContent).toContain('Alice is employed by Acme');
  });
});

// ---------------------------------------------------------------------------
// summarizeNodes prompts
// ---------------------------------------------------------------------------

describe('summarizeNodes prompts', () => {
  test('summarizePair returns valid messages', () => {
    const msgs = promptLibrary.summarizeNodes.summarizePair({
      summaries: ['Alice is a developer.', 'Alice joined Acme.']
    });
    assertValidMessages(msgs);
  });

  test('summarizeContext returns valid messages', () => {
    const msgs = promptLibrary.summarizeNodes.summarizeContext({
      entity_name: 'Alice',
      entity_types: ['Person'],
      episode_content: 'Alice works at Acme.',
      existing_summary: ''
    });
    assertValidMessages(msgs);
  });

  test('summaryDescription returns valid messages', () => {
    const msgs = promptLibrary.summarizeNodes.summaryDescription({
      summary: 'Alice is a developer at Acme Corp.'
    });
    assertValidMessages(msgs);
  });
});

// ---------------------------------------------------------------------------
// eval prompts
// ---------------------------------------------------------------------------

describe('eval prompts', () => {
  test('queryExpansion returns valid messages', () => {
    const msgs = promptLibrary.eval.queryExpansion({
      query: 'Where does Alice work?'
    });
    assertValidMessages(msgs);
  });

  test('qaPrompt returns valid messages', () => {
    const msgs = promptLibrary.eval.qaPrompt({
      context: 'Alice works at Acme Corp.',
      question: 'Where does Alice work?'
    });
    assertValidMessages(msgs);
  });

  test('evalPrompt returns valid messages', () => {
    const msgs = promptLibrary.eval.evalPrompt({
      question: 'Where does Alice work?',
      expected_answer: 'Acme Corp',
      actual_answer: 'Acme'
    });
    assertValidMessages(msgs);
  });

  test('evalAddEpisodeResults returns valid messages', () => {
    const msgs = promptLibrary.eval.evalAddEpisodeResults({
      question: 'Where does Alice work?',
      answer: 'Acme',
      baseline_context: 'context1',
      candidate_context: 'context2'
    });
    assertValidMessages(msgs);
  });
});

// ---------------------------------------------------------------------------
// promptLibrary structure
// ---------------------------------------------------------------------------

describe('promptLibrary structure', () => {
  test('has all expected namespaces', () => {
    expect(promptLibrary.extractNodes).toBeDefined();
    expect(promptLibrary.extractEdges).toBeDefined();
    expect(promptLibrary.dedupeNodes).toBeDefined();
    expect(promptLibrary.dedupeEdges).toBeDefined();
    expect(promptLibrary.summarizeNodes).toBeDefined();
    expect(promptLibrary.eval).toBeDefined();
  });

  test('all prompt functions are callable', () => {
    const functions = [
      promptLibrary.extractNodes.extractMessage,
      promptLibrary.extractNodes.extractJson,
      promptLibrary.extractNodes.extractText,
      promptLibrary.extractNodes.classifyNodes,
      promptLibrary.extractNodes.extractAttributes,
      promptLibrary.extractNodes.extractSummary,
      promptLibrary.extractNodes.extractSummariesBatch,
      promptLibrary.extractEdges.extractEdges,
      promptLibrary.extractEdges.extractEdgeAttributes,
      promptLibrary.dedupeNodes.dedupeNode,
      promptLibrary.dedupeNodes.dedupeNodes,
      promptLibrary.dedupeNodes.dedupeNodeList,
      promptLibrary.dedupeEdges.resolveEdge,
      promptLibrary.summarizeNodes.summarizePair,
      promptLibrary.summarizeNodes.summarizeContext,
      promptLibrary.summarizeNodes.summaryDescription,
      promptLibrary.eval.queryExpansion,
      promptLibrary.eval.qaPrompt,
      promptLibrary.eval.evalPrompt,
      promptLibrary.eval.evalAddEpisodeResults
    ];

    for (const fn of functions) {
      expect(typeof fn).toBe('function');
    }
  });
});

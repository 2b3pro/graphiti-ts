import { describe, expect, test } from 'bun:test';

import {
  totalTokens,
  promptTotalTokens,
  avgInputTokens,
  avgOutputTokens,
  TokenUsageTracker
} from './token-tracker';
import type { TokenUsage, PromptTokenUsage } from './token-tracker';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

describe('totalTokens', () => {
  test('sums input and output tokens', () => {
    const usage: TokenUsage = { input_tokens: 100, output_tokens: 50 };
    expect(totalTokens(usage)).toBe(150);
  });

  test('returns 0 for zero usage', () => {
    expect(totalTokens({ input_tokens: 0, output_tokens: 0 })).toBe(0);
  });
});

describe('promptTotalTokens', () => {
  test('sums total input and output tokens', () => {
    const usage: PromptTokenUsage = {
      call_count: 3,
      total_input_tokens: 300,
      total_output_tokens: 150
    };
    expect(promptTotalTokens(usage)).toBe(450);
  });
});

describe('avgInputTokens', () => {
  test('computes average input tokens per call', () => {
    const usage: PromptTokenUsage = {
      call_count: 4,
      total_input_tokens: 200,
      total_output_tokens: 100
    };
    expect(avgInputTokens(usage)).toBe(50);
  });

  test('returns 0 when call count is 0', () => {
    const usage: PromptTokenUsage = {
      call_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0
    };
    expect(avgInputTokens(usage)).toBe(0);
  });
});

describe('avgOutputTokens', () => {
  test('computes average output tokens per call', () => {
    const usage: PromptTokenUsage = {
      call_count: 5,
      total_input_tokens: 250,
      total_output_tokens: 100
    };
    expect(avgOutputTokens(usage)).toBe(20);
  });

  test('returns 0 when call count is 0', () => {
    expect(
      avgOutputTokens({ call_count: 0, total_input_tokens: 0, total_output_tokens: 0 })
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TokenUsageTracker
// ---------------------------------------------------------------------------

describe('TokenUsageTracker', () => {
  test('records and retrieves usage for a prompt type', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('extract_nodes', { input_tokens: 100, output_tokens: 50 });

    const usage = tracker.getUsage();
    const entry = usage.get('extract_nodes');
    expect(entry).toBeDefined();
    expect(entry!.call_count).toBe(1);
    expect(entry!.total_input_tokens).toBe(100);
    expect(entry!.total_output_tokens).toBe(50);
  });

  test('accumulates multiple calls for same prompt type', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('dedupe', { input_tokens: 100, output_tokens: 50 });
    tracker.record('dedupe', { input_tokens: 200, output_tokens: 80 });
    tracker.record('dedupe', { input_tokens: 150, output_tokens: 60 });

    const entry = tracker.getUsage().get('dedupe')!;
    expect(entry.call_count).toBe(3);
    expect(entry.total_input_tokens).toBe(450);
    expect(entry.total_output_tokens).toBe(190);
  });

  test('tracks multiple prompt types independently', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('extract', { input_tokens: 100, output_tokens: 50 });
    tracker.record('dedupe', { input_tokens: 200, output_tokens: 100 });

    const usage = tracker.getUsage();
    expect(usage.size).toBe(2);
    expect(usage.get('extract')!.total_input_tokens).toBe(100);
    expect(usage.get('dedupe')!.total_input_tokens).toBe(200);
  });

  test('getTotalUsage aggregates across all prompt types', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('a', { input_tokens: 100, output_tokens: 50 });
    tracker.record('b', { input_tokens: 200, output_tokens: 80 });
    tracker.record('a', { input_tokens: 50, output_tokens: 30 });

    const total = tracker.getTotalUsage();
    expect(total.call_count).toBe(3);
    expect(total.total_input_tokens).toBe(350);
    expect(total.total_output_tokens).toBe(160);
  });

  test('getTotalUsage returns zeros when empty', () => {
    const tracker = new TokenUsageTracker();
    const total = tracker.getTotalUsage();
    expect(total.call_count).toBe(0);
    expect(total.total_input_tokens).toBe(0);
    expect(total.total_output_tokens).toBe(0);
  });

  test('reset clears all tracked usage', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('x', { input_tokens: 100, output_tokens: 50 });
    tracker.reset();
    expect(tracker.getUsage().size).toBe(0);
    expect(tracker.getTotalUsage().call_count).toBe(0);
  });

  test('getUsage returns a copy (not the internal map)', () => {
    const tracker = new TokenUsageTracker();
    tracker.record('test', { input_tokens: 10, output_tokens: 5 });
    const copy = tracker.getUsage();
    copy.delete('test');
    // Original tracker should still have the data
    expect(tracker.getUsage().has('test')).toBe(true);
  });
});

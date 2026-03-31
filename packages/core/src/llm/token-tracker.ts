/**
 * Token usage tracking — port of Python's graphiti_core/llm_client/token_tracker.py.
 */

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export function totalTokens(usage: TokenUsage): number {
  return usage.input_tokens + usage.output_tokens;
}

export interface PromptTokenUsage {
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export function promptTotalTokens(usage: PromptTokenUsage): number {
  return usage.total_input_tokens + usage.total_output_tokens;
}

export function avgInputTokens(usage: PromptTokenUsage): number {
  return usage.call_count > 0 ? usage.total_input_tokens / usage.call_count : 0;
}

export function avgOutputTokens(usage: PromptTokenUsage): number {
  return usage.call_count > 0 ? usage.total_output_tokens / usage.call_count : 0;
}

function createPromptTokenUsage(): PromptTokenUsage {
  return { call_count: 0, total_input_tokens: 0, total_output_tokens: 0 };
}

export class TokenUsageTracker {
  private usage: Map<string, PromptTokenUsage> = new Map();

  /**
   * Record token usage for a prompt type.
   */
  record(promptType: string, tokenUsage: TokenUsage): void {
    let existing = this.usage.get(promptType);
    if (!existing) {
      existing = createPromptTokenUsage();
      this.usage.set(promptType, existing);
    }
    existing.call_count += 1;
    existing.total_input_tokens += tokenUsage.input_tokens;
    existing.total_output_tokens += tokenUsage.output_tokens;
  }

  /**
   * Get a copy of the current usage by prompt type.
   */
  getUsage(): Map<string, PromptTokenUsage> {
    return new Map(this.usage);
  }

  /**
   * Get aggregate usage across all prompt types.
   */
  getTotalUsage(): PromptTokenUsage {
    const total = createPromptTokenUsage();
    for (const usage of this.usage.values()) {
      total.call_count += usage.call_count;
      total.total_input_tokens += usage.total_input_tokens;
      total.total_output_tokens += usage.total_output_tokens;
    }
    return total;
  }

  /**
   * Clear all tracked usage.
   */
  reset(): void {
    this.usage.clear();
  }

  /**
   * Print a formatted summary of token usage to console.
   */
  printSummary(sortBy: 'calls' | 'tokens' = 'tokens'): void {
    const entries = [...this.usage.entries()];

    entries.sort((a, b) =>
      sortBy === 'calls'
        ? b[1].call_count - a[1].call_count
        : promptTotalTokens(b[1]) - promptTotalTokens(a[1])
    );

    console.log('\n=== Token Usage Summary ===');
    for (const [promptType, usage] of entries) {
      console.log(
        `  ${promptType}: ${usage.call_count} calls, ` +
        `${promptTotalTokens(usage)} tokens ` +
        `(in: ${usage.total_input_tokens}, out: ${usage.total_output_tokens}, ` +
        `avg_in: ${Math.round(avgInputTokens(usage))}, avg_out: ${Math.round(avgOutputTokens(usage))})`
      );
    }

    const total = this.getTotalUsage();
    console.log(
      `  TOTAL: ${total.call_count} calls, ` +
      `${promptTotalTokens(total)} tokens ` +
      `(in: ${total.total_input_tokens}, out: ${total.total_output_tokens})`
    );
    console.log('===========================\n');
  }
}

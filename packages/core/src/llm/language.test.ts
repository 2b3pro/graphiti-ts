import { describe, expect, test } from 'bun:test';

import { getExtractionLanguageInstruction } from './language';

describe('getExtractionLanguageInstruction', () => {
  test('returns a non-empty instruction string', () => {
    const result = getExtractionLanguageInstruction();
    expect(result.length).toBeGreaterThan(0);
  });

  test('instruction mentions language extraction behavior', () => {
    const result = getExtractionLanguageInstruction();
    expect(result).toContain('language');
    expect(result).toContain('English');
  });

  test('returns same instruction regardless of groupId', () => {
    const withGroup = getExtractionLanguageInstruction('group-1');
    const withNull = getExtractionLanguageInstruction(null);
    const withUndef = getExtractionLanguageInstruction();
    expect(withGroup).toBe(withNull);
    expect(withNull).toBe(withUndef);
  });
});

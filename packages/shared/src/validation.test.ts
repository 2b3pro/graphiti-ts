import { describe, expect, test } from 'bun:test';

import {
  GroupIdValidationError,
  NodeLabelValidationError,
  validateGroupId,
  validateGroupIds,
  validateNodeLabels
} from './index';

describe('validation', () => {
  test('accepts empty group ids', () => {
    expect(validateGroupId('')).toBeTrue();
    expect(validateGroupId(null)).toBeTrue();
    expect(validateGroupIds(['alpha', 'beta_1', 'gamma-2'])).toBeTrue();
  });

  test('rejects invalid group ids', () => {
    expect(() => validateGroupId('bad space')).toThrow(GroupIdValidationError);
    expect(() => validateGroupId('bad/slash')).toThrow(GroupIdValidationError);
  });

  test('accepts safe node labels', () => {
    expect(validateNodeLabels(['Entity', '_Internal', 'CustomLabel2'])).toBeTrue();
  });

  test('rejects unsafe node labels', () => {
    expect(() => validateNodeLabels(['Bad-Label'])).toThrow(NodeLabelValidationError);
    expect(() => validateNodeLabels(['123Bad'])).toThrow(NodeLabelValidationError);
  });
});

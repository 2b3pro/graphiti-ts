import { describe, expect, test } from 'bun:test';

import { isTelemetryEnabled, getAnonymousId } from './telemetry';

describe('telemetry', () => {
  test('isTelemetryEnabled returns a boolean', () => {
    const result = isTelemetryEnabled();
    expect(typeof result).toBe('boolean');
  });

  test('getAnonymousId returns a non-empty string', () => {
    const id = getAnonymousId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('getAnonymousId returns consistent value on repeated calls', () => {
    const id1 = getAnonymousId();
    const id2 = getAnonymousId();
    expect(id1).toBe(id2);
  });
});

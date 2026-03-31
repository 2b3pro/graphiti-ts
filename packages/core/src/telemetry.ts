/**
 * Telemetry module — port of Python's graphiti_core/telemetry/telemetry.py.
 *
 * Collects anonymous usage statistics via PostHog.
 * Telemetry can be disabled by setting GRAPHITI_TELEMETRY_ENABLED=false.
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// PostHog configuration — public API key intended for client-side use
const POSTHOG_API_KEY = 'phc_UG6EcfDbuXz92neb3rMlQFDY0csxgMqRcIPWESqnSmo';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const TELEMETRY_ENV_VAR = 'GRAPHITI_TELEMETRY_ENABLED';

let cachedAnonymousId: string | null = null;

export function isTelemetryEnabled(): boolean {
  try {
    const envValue = process.env[TELEMETRY_ENV_VAR]?.toLowerCase() ?? 'true';
    return envValue === 'true' || envValue === '1' || envValue === 'yes' || envValue === 'on';
  } catch {
    return false;
  }
}

export function getAnonymousId(): string {
  if (cachedAnonymousId) return cachedAnonymousId;

  try {
    const cacheDir = join(homedir(), '.cache', 'graphiti');
    const idFile = join(cacheDir, 'telemetry_anon_id');

    if (existsSync(idFile)) {
      const id = readFileSync(idFile, 'utf-8').trim();
      if (id) {
        cachedAnonymousId = id;
        return id;
      }
    }

    const newId = randomUUID();
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(idFile, newId);
    } catch {
      // Can't persist — use in-memory only
    }

    cachedAnonymousId = newId;
    return newId;
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Capture a telemetry event. Sends asynchronously via PostHog HTTP API.
 * Silently swallows all errors.
 */
export function captureEvent(
  eventName: string,
  properties?: Record<string, unknown>
): void {
  if (!isTelemetryEnabled()) return;

  try {
    const userId = getAnonymousId();
    const eventProperties = {
      $process_person_profile: false,
      ...(properties ?? {})
    };

    // Fire-and-forget HTTP POST to PostHog
    fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_API_KEY,
        event: eventName,
        distinct_id: userId,
        properties: eventProperties
      })
    }).catch(() => {
      // Silently ignore network errors
    });
  } catch {
    // Silently handle all telemetry errors
  }
}

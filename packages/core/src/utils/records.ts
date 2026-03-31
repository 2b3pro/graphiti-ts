export interface RecordLike {
  get?(key: string): unknown;
  [key: string]: unknown;
}

export function getRecordValue<T = unknown>(record: RecordLike, key: string): T | undefined {
  if (typeof record.get === 'function') {
    return record.get(key) as T;
  }

  return record[key] as T | undefined;
}

export function parseDateValue(value: unknown): Date | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  }

  if (typeof value === 'object' && value !== null && 'toString' in value) {
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  }

  return null;
}

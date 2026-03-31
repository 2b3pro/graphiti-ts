export function serializeForCypher<T>(value: T): T {
  if (value instanceof Date) {
    return value.toISOString() as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeForCypher(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (item === undefined) {
          return [];
        }

        if (item && typeof item === 'object' && !(item instanceof Date) && !Array.isArray(item)) {
          return [[key, JSON.stringify(item)]];
        }

        if (item instanceof Date) {
          return [[key, item.toISOString()]];
        }

        if (Array.isArray(item)) {
          return [[key, item.map((el) =>
            el instanceof Date ? el.toISOString() : el
          )]];
        }

        return [[key, item]];
      })
    ) as T;
  }

  return value;
}

export function serializeForFalkor<T>(value: T): T {
  if (value instanceof Date) {
    return value.toISOString() as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object' && !(item instanceof Date) && !Array.isArray(item)) {
        return JSON.stringify(item);
      }
      return serializeForFalkor(item);
    }) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (item === undefined) {
          return [];
        }

        if (item && typeof item === 'object' && !(item instanceof Date) && !Array.isArray(item)) {
          return [[key, JSON.stringify(item)]];
        }

        return [[key, serializeForFalkor(item)]];
      })
    ) as T;
  }

  return value;
}

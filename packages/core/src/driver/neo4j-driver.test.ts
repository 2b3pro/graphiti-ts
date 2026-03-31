import { describe, expect, test } from 'bun:test';

import type {
  GraphDriverSession,
  QueryOptions,
  QueryResult
} from '../contracts';
import { Neo4jDriver } from './neo4j-driver';

describe('Neo4jDriver', () => {
  test('forwards executeQuery options to the client adapter', async () => {
    const calls: Array<{
      query: string;
      options: { parameters: Record<string, unknown>; database: string; routing?: 'r' | 'w' };
    }> = [];

    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test',
        database: 'neo4j'
      },
      {
        async executeQuery(query, options) {
          calls.push({ query, options });
          return { records: [], keys: [], summary: null };
        },
        session(): GraphDriverSession {
          return new FakeSession();
        },
        async close() {},
        async verifyConnectivity() {}
      }
    );

    await driver.executeQuery('RETURN 1', {
      params: { value: 1 },
      database: 'graphiti',
      routing: 'r'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      query: 'RETURN 1',
      options: {
        parameters: { value: 1 },
        database: 'graphiti',
        routing: 'r'
      }
    });
  });

  test('uses fallback transaction for generic sessions', async () => {
    const session = new FakeSession();

    const driver = new Neo4jDriver(
      {
        uri: 'bolt://localhost:7687',
        user: 'neo4j',
        password: 'test'
      },
      {
        async executeQuery() {
          return { records: [], keys: [], summary: null };
        },
        session(): GraphDriverSession {
          return session;
        },
        async close() {}
      }
    );

    const transaction = await driver.transaction();
    await transaction.run('RETURN 1', { value: 1 });
    await transaction.commit();

    expect(session.calls).toEqual([
      {
        cypherQuery: 'RETURN 1',
        options: { params: { value: 1 } }
      }
    ]);
    expect(session.closed).toBeTrue();
  });
});

class FakeSession implements GraphDriverSession {
  calls: Array<{ cypherQuery: string; options?: QueryOptions }> = [];
  closed = false;

  async executeQuery<RecordShape = unknown>(
    cypherQuery: string,
    options?: QueryOptions
  ): Promise<QueryResult<RecordShape>> {
    if (options) {
      this.calls.push({ cypherQuery, options });
    } else {
      this.calls.push({ cypherQuery });
    }
    return { records: [], keys: [], summary: null };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

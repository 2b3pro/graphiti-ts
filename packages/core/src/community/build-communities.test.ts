import { expect, test } from 'bun:test';
import { utcNow } from '@graphiti/shared';

import type { EntityNode } from '../domain/nodes';
import type { LLMClient, GraphDriver } from '../contracts';

import {
  buildCommunities,
  type EntityNodeNamespaceReader
} from './community-operations';

function entity(uuid: string, name: string, summary: string): EntityNode {
  return { uuid, name, group_id: 'g1', labels: ['Entity'], created_at: utcNow(), summary };
}

function rec(data: Record<string, unknown>) {
  return { get: (k: string) => data[k] };
}

test('buildCommunities orchestration', async () => {
  const entities = [entity('e1', 'A', 'SA'), entity('e2', 'B', 'SB')];
  let calls = 0;
  const llm: LLMClient = {
    model: 'fake', small_model: null, setTracer() {},
    async generateText(): Promise<string> {
      calls++;
      return calls === 1 ? '{"summary":"Team"}' : '{"description":"Desc"}';
    }
  };
  const ns: EntityNodeNamespaceReader = {
    async getByGroupIds() { return entities; },
    async getByUuids(uuids: string[]) { return entities.filter((e) => uuids.includes(e.uuid)); }
  };
  const driver = {
    async executeQuery(_q: string, opts?: any) {
      const uuid = opts?.params?.uuid;
      return { records: [rec({ uuid: uuid === 'e1' ? 'e2' : 'e1', count: 2 })], summary: {} };
    }
  } as unknown as GraphDriver;
  const [nodes, edges] = await buildCommunities(driver, llm, ns, ['g1']);
  expect(nodes).toHaveLength(1);
  expect(edges).toHaveLength(2);
});

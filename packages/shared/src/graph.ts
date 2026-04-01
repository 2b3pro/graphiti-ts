export const SAFE_CYPHER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const GROUP_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export type GraphProvider = 'neo4j' | 'falkordb';

export const GraphProviders = {
  NEO4J: 'neo4j',
  FALKORDB: 'falkordb'
} as const satisfies Record<string, GraphProvider>;

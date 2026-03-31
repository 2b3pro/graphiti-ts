# Graphiti TS

Temporally-aware knowledge graphs for AI agents — in TypeScript.

Graphiti enables real-time, incremental construction of knowledge graphs from conversational and unstructured data. Unlike traditional RAG, Graphiti maintains a persistent, evolving graph that captures entities, relationships, and temporal context without batch recomputation.

TypeScript port of [getzep/graphiti](https://github.com/getzep/graphiti).

## Why Graphiti

- **Dynamic memory for agents** — Continuously ingest conversations, documents, and events into a structured knowledge graph that agents can query in real time
- **Bi-temporal model** — Track both when events occurred and when they were recorded, enabling point-in-time queries and temporal reasoning
- **Hybrid retrieval** — Combine semantic embeddings, BM25 keyword search, and graph traversal in a single query
- **No batch recomputation** — Add episodes incrementally; the graph updates in place with LLM-driven entity extraction, deduplication, and resolution

## Install

```bash
bun add @graphiti/core
# or
npm install @graphiti/core
```

## Quick Start

```typescript
import { Graphiti } from '@graphiti/core';

// Connect to Neo4j
const graphiti = new Graphiti({
  uri: 'bolt://localhost:7687',
  user: 'neo4j',
  password: 'password',
});

await graphiti.buildIndicesAndConstraints();

// Ingest an episode
await graphiti.addEpisode({
  name: 'meeting-notes',
  body: 'Alice mentioned she prefers morning standups. Bob disagreed and suggested async updates.',
  referenceTime: new Date(),
  source: 'message',
  sourceDescription: 'Team chat',
});

// Search the knowledge graph
const results = await graphiti.search('What does Alice prefer?');
console.log(results.nodes); // Entities: Alice, Bob
console.log(results.edges); // Relationships: Alice -> prefers -> morning standups
```

## Features

| Feature | Details |
|---------|---------|
| **Graph backends** | Neo4j, FalkorDB |
| **LLM providers** | OpenAI, Anthropic, Gemini, Groq, Azure OpenAI, Ollama, Voyage AI |
| **Entity extraction** | LLM-driven with custom entity and edge type definitions |
| **Deduplication** | MinHash fuzzy matching + LLM-based resolution (CJK-aware) |
| **Search** | Semantic, BM25 fulltext, graph traversal, community-based, combined hybrid |
| **Bulk ingestion** | Parallel episode processing with cross-episode dedup |
| **Observability** | OpenTelemetry distributed tracing |
| **MCP server** | Model Context Protocol integration for AI assistants |

## Packages

| Package | Description |
|---------|-------------|
| [`@graphiti/core`](packages/core) | Core knowledge graph library |
| [`@graphiti/mcp`](packages/mcp) | MCP server for AI assistant integration |
| [`@graphiti/shared`](packages/shared) | Shared utilities and types |

## Graph Backends

### Neo4j

```typescript
const graphiti = new Graphiti({
  uri: 'bolt://localhost:7687',
  user: 'neo4j',
  password: 'password',
});
```

Requires Neo4j 5.26+. Install via [Neo4j Desktop](https://neo4j.com/download/) or Docker:

```bash
docker run -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5
```

### FalkorDB

```typescript
import { Graphiti, FalkorDriver } from '@graphiti/core';

const driver = new FalkorDriver({ host: 'localhost', port: 6379 });
const graphiti = new Graphiti({ driver });
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes (default provider) | OpenAI API key for LLM and embeddings |
| `ANTHROPIC_API_KEY` | For Anthropic | Claude models |
| `GOOGLE_API_KEY` | For Gemini | Gemini models |
| `GROQ_API_KEY` | For Groq | Groq-hosted models |
| `VOYAGE_API_KEY` | For Voyage | Voyage AI embeddings |
| `AZURE_OPENAI_API_KEY` | For Azure | Azure OpenAI endpoint |

## Development

```bash
# Install dependencies
bun install

# Type check all packages
bun run typecheck

# Build all packages
bun run build

# Run tests
bun run test

# Lint & format
bun run lint
bun run format
```

## Architecture

```
@graphiti/core
├── graphiti.ts          # Main Graphiti class — orchestrates ingestion and search
├── driver/              # Graph database drivers (Neo4j, FalkorDB)
│   └── operations/      # Database operation interfaces
├── maintenance/         # LLM-driven extraction, resolution, deduplication
├── search/              # Hybrid search (semantic + BM25 + graph traversal)
├── prompts/             # LLM prompt templates
├── providers/           # LLM, embedder, and reranker provider clients
├── community/           # Community detection (label propagation + LLM summarization)
└── utils/               # Concurrency, text processing, content chunking
```

## License

Apache-2.0 — see [LICENSE](LICENSE)

## Acknowledgments

Graphiti was originally created by [Zep](https://www.getzep.com/). This TypeScript port is maintained independently.

- [Python original](https://github.com/getzep/graphiti)
- [Zep documentation](https://docs.getzep.com/graphiti)

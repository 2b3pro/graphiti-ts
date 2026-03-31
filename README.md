# Graphiti TypeScript

Temporally-aware knowledge graphs for AI agents.

This is the TypeScript port of [getzep/graphiti](https://github.com/getzep/graphiti), a framework for building dynamic knowledge graphs that support real-time incremental updates without batch recomputation.

## Install

```bash
bun add @graphiti/core
# or
npm install @graphiti/core
```

## Quick Start

```typescript
import { Graphiti } from '@graphiti/core';

const graphiti = new Graphiti({
  uri: 'bolt://localhost:7687',
  user: 'neo4j',
  password: 'password',
});

// Initialize the graph
await graphiti.buildIndicesAndConstraints();

// Add episodes (data points with temporal context)
await graphiti.addEpisode({
  name: 'meeting-notes',
  body: 'Alice mentioned she prefers morning standups.',
  referenceTime: new Date(),
  source: 'message',
  sourceDescription: 'Team chat',
});

// Search the knowledge graph
const results = await graphiti.search('What does Alice prefer?');
```

## Features

- **Bi-temporal data model** -- tracks both when events occurred and when they were recorded
- **Hybrid retrieval** -- combines semantic embeddings, BM25 keyword search, and graph traversal
- **Custom entity definitions** -- define domain-specific entity types via TypeScript types
- **Real-time incremental updates** -- no batch recomputation needed
- **Multiple backends** -- Neo4j and FalkorDB graph database support
- **LLM provider support** -- OpenAI, Anthropic, Gemini, Groq, Azure OpenAI, Ollama, Voyage AI
- **OpenTelemetry tracing** -- distributed tracing for observability
- **MCP server** -- Model Context Protocol integration for AI assistants

## Packages

| Package | Description |
|---------|-------------|
| `@graphiti/core` | Core knowledge graph library |
| `@graphiti/mcp` | MCP server for AI assistant integration |
| `@graphiti/shared` | Shared utilities and types |

## Development

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Build all packages
bun run build

# Run tests
bun run test

# Lint
bun run lint

# Format
bun run format
```

## License

Apache-2.0

## Links

- [Python original](https://github.com/getzep/graphiti)
- [Documentation](https://docs.getzep.com/graphiti)

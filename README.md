# Graphiti TS

Temporally-aware knowledge graphs for AI agents — in TypeScript.

Graphiti enables real-time, incremental construction of knowledge graphs from conversational and unstructured data. Unlike traditional RAG, Graphiti maintains a persistent, evolving graph that captures entities, relationships, and temporal context without batch recomputation.

This is a customized TypeScript port of and inspired by [getzep/graphiti](https://github.com/getzep/graphiti).

## What's Different from the Python Original

This port tracks the upstream provider coverage (OpenAI, Anthropic, Gemini, Groq, Azure, Ollama, Voyage, GLiNER2, BGE) but adds several features not found in the original:

| Feature | Description |
|---------|-------------|
| **Edge quality gate** | Weighted birth-gate scoring (persistence, specificity, novelty) that filters low-value edges at ingestion time. Configurable threshold and weights. |
| **Epistemic status** | Nine-state lifecycle for edge assertions: `fact`, `claim`, `disputed`, `decision`, `opinion`, `hypothesis`, `observation`, `preference`, `deprecated`. Includes transition audit trail. |
| **Evidence weight** | Computed strength metric based on supporting/disputing edge counts, with corroboration and contradiction tracking. |
| **Confidence bands** | `[low, mid, high]` uncertainty ranges on edges, validated to 0.0-1.0 with low <= mid <= high. |
| **Temporal search** | `searchAsOf(query, date)` for point-in-time graph queries against the bi-temporal model. |
| **Jina reranker** | Cross-encoder reranking via the Jina Reranker API, alongside the ported BGE/OpenAI/Gemini rerankers. |
| **YAML-driven config** | Centralized `config.yaml` with fallback chains for LLM, embedder, and reranker providers. |
| **CJK-aware dedup** | Adaptive MinHash shingle sizes (n=2 for CJK scripts, n=3 for Latin) with proper Unicode range detection. |

Removed from the Python original: Kuzu and Neptune graph backends (this port supports Neo4j and FalkorDB only).

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
| **MCP server** | [Model Context Protocol](https://modelcontextprotocol.io/) integration for AI assistants |

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

## Prerequisites

### Required

| Dependency | Version | Description |
|------------|---------|-------------|
| [Neo4j](https://neo4j.com/) | 5.26+ | Graph database. Install via [Neo4j Desktop](https://neo4j.com/download/), Docker, or AuraDB cloud. |
| [Bun](https://bun.sh/) | 1.0+ | JavaScript runtime and package manager (also supports Node.js via npm) |

Or, alternatively to Neo4j:

| Dependency | Version | Description |
|------------|---------|-------------|
| [FalkorDB](https://www.falkordb.com/) | 6.x | Redis-compatible graph database (alternative to Neo4j) |

### LLM Providers (at least one required)

An LLM is needed for entity extraction, deduplication, and resolution.

| Provider | SDK | Models |
|----------|-----|--------|
| [OpenAI](https://platform.openai.com/) | `openai` ^4.60 | GPT-4o, GPT-4o-mini, etc. |
| [Anthropic](https://console.anthropic.com/) | `@anthropic-ai/sdk` ^0.80 | Claude Sonnet, Haiku, etc. |
| [Google Gemini](https://ai.google.dev/) | `@google/generative-ai` ^0.24 | Gemini 2.5 Flash, Pro, etc. |
| [Groq](https://console.groq.com/) | `openai` (compatible) | Llama 3.3, Mixtral, etc. |
| [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service) | `openai` (Azure config) | Azure-hosted OpenAI models |
| [Ollama](https://ollama.ai/) | `openai` (compatible) | Any local model (Llama, Qwen, Mistral, etc.) |
| Any OpenAI-compatible endpoint | `openai` (generic) | Via `OpenAIGenericClient` with custom `baseURL` |

### Embedding Providers (at least one required)

Vector embeddings power semantic similarity search.

| Provider | Description |
|----------|-------------|
| [OpenAI Embeddings](https://platform.openai.com/docs/guides/embeddings) | `text-embedding-3-small` / `text-embedding-3-large` |
| [Google Gemini Embeddings](https://ai.google.dev/gemini-api/docs/embeddings) | `text-embedding-004` |
| [Voyage AI](https://www.voyageai.com/) | `voyage-3` (1024-dim) |
| [Ollama](https://ollama.ai/) | Local embeddings, e.g. `nomic-embed-text` (768-dim) |
| [Azure OpenAI Embeddings](https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models#embeddings) | Azure-hosted OpenAI embedding models |

### Reranker Providers (optional)

Cross-encoder reranking improves search result relevance.

| Provider | Description |
|----------|-------------|
| [Jina Reranker](https://jina.ai/reranker/) | `jina-reranker-v3` (API key via `JINA_API_KEY`) |
| [OpenAI](https://platform.openai.com/) | LLM-based reranking |
| [Google Gemini](https://ai.google.dev/) | LLM-based reranking |
| [BGE Reranker](https://huggingface.co/BAAI/bge-reranker-v2-m3) | Self-hosted TEI endpoint (`BAAI/bge-reranker-v2-m3`) |

### Entity Extraction (optional)

| Provider | Description |
|----------|-------------|
| [GLiNER 2](https://github.com/urchade/GLiNER) | Self-hosted NER model for fast entity extraction without LLM calls |

## Configuration

Copy the sample config and edit for your environment:

```bash
cp config.sample.yaml config.yaml
```

See [`config.sample.yaml`](config.sample.yaml) for all available settings including LLM fallback chains, embedding providers, reranker configuration, search defaults, and quality gates.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes (default provider) | OpenAI API key for LLM and embeddings |
| `ANTHROPIC_API_KEY` | For Anthropic | Claude models |
| `GOOGLE_API_KEY` | For Gemini | Gemini models |
| `GROQ_API_KEY` | For Groq | Groq-hosted models |
| `VOYAGE_API_KEY` | For Voyage | Voyage AI embeddings |
| `JINA_API_KEY` | For Jina | Jina reranker and embeddings |
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

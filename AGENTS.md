# Repository Guidelines

## Project Structure & Module Organization

This is a Bun/TypeScript monorepo. Packages live under `packages/*`:

- `packages/core`: core Graphiti library, graph operations, ingestion, providers, prompts, search, and maintenance logic.
- `packages/mcp`: MCP server entry points and configuration.
- `packages/shared`: shared types, validation, errors, graph helpers, and time utilities.

Source files are in each package's `src/` directory. Tests are colocated as `*.test.ts`. Reference material is in `docs/`, planning notes are in `spec/`, and release or policy checks live in `scripts/`.

## Build, Test, and Development Commands

- `bun install`: install workspace dependencies from `bun.lock`.
- `bun run build`: build all workspace packages into their package `dist/` directories and emit declarations.
- `bun run typecheck`: run `tsc --noEmit` for all packages.
- `bun run test`: run package tests with `bun test`.
- `bun run lint`: run Biome checks across TypeScript, JavaScript, and JSON files.
- `bun run format`: apply Biome formatting.
- `bun run verify`: run the repository boundary check, build, typecheck, and tests.
- `bun run release:cut -- vX.Y.Z`: rebuild release artifacts and run release gates.

## Coding Style & Naming Conventions

Use TypeScript ES modules. Biome controls formatting: tabs, single quotes, semicolons, and 100-character lines. Prefer named exports for shared APIs and route package public surfaces through `src/index.ts`.

Use kebab-case for multiword filenames, for example `edge-quality.ts` and `bulk-utils.test.ts`. Keep code grouped by capability (`domain/`, `ingest/`, `search/`, `providers/`).

## Testing Guidelines

Use Bun's test runner. Add tests beside the code they cover with the `*.test.ts` suffix. Focus on public behavior, temporal/search semantics, validation failures, and provider boundaries. Run `bun run test` for the full suite, or target a file during iteration:

```bash
bun test packages/core/src/search/search.test.ts
```

Before handing off broad changes, run `bun run verify`.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes such as `feat(search): ...`, `fix(dedup): ...`, and `fix: ...`. Keep commits imperative and scoped when useful:

- `feat(resolution): add concurrency throttle`
- `fix(temporal): serialize search date params`

Pull requests should describe the behavior change, list validation performed, and call out config or release-impacting changes. Link related issues when available.

## Security & Configuration Tips

Do not commit credentials or provider API keys. Use local env files based on `.env.test.example` and configuration based on `config.sample.yaml`. Keep project-specific or private paths out of reusable package code.

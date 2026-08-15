# NUAI

**not ur avg ai**

NUAI is a small local-first TypeScript agent harness. The first slice establishes the runtime contracts without pretending that model integrations, semantic embeddings, or remote deployment already exist.

## Included

- Observe → plan → act agent loop
- Provider-neutral text model contract
- HMAC gateway tokens
- `.nuai/` workspace initialization
- SQLite memory store
- Pure cosine vector search boundary
- Zod-validated skill registry
- `ts-morph` skill source generation and `esbuild` compilation
- Hono health/version API
- Ink CLI and Vite web shell
- Vitest coverage gate with per-file 80% thresholds
- Biome formatting and linting
- Git-tag/package-lock version verification

## Setup

```bash
npm install
npm run gate
npm run build
node dist/cli.js --version
node dist/cli.js init
```

`nuai init` creates `.nuai/config.json` in the current directory. Runtime memory is stored at `.nuai/memory.db`.

## Commands

```bash
npm run dev
npm run dev:server
npm run dev:web
npm run test:coverage
npm run version:check
```

The default provider is `ollama`; provider adapters are contracts only in this foundation slice. No model response is fabricated when a provider is not configured.

## Versioning

The package version and latest Git tag must match:

```text
package.json 0.1.0
Git tag       v0.1.0
```

Run `npm run version:check` before creating the next release tag.

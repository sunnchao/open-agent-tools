# Studio Web

`@open-agent-tools/studio-web` is the unified visual workspace for Agent chat, complete MCP administration and live Tool calls, RAG knowledge bases, and drag-and-drop workflow orchestration.

## Start

```bash
pnpm --filter @open-agent-tools/studio-web dev
```

The default URL is `http://localhost:5173`. Development proxies route Agent requests to `:3000`, MCP administration to `:4200`, MCP Gateway calls to `:4100`, and RAG requests to `:4001`.

## Verify

```bash
pnpm --filter @open-agent-tools/studio-web typecheck
pnpm --filter @open-agent-tools/studio-web lint
pnpm --filter @open-agent-tools/studio-web test
pnpm --filter @open-agent-tools/studio-web build
```

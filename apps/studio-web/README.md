# Studio Web

`@open-agent-tools/studio-web` 是统一可视化工作台，包含 Agent 对话、MCP 管理与真实 Tool 调用、RAG 知识库和可拖拽工作流编排。

## 启动

```bash
pnpm --filter @open-agent-tools/studio-web dev
```

默认地址为 `http://localhost:5173`。本地开发代理：

- `/api` -> Agent Server `:3000`
- `/mcp-api` -> MCP Control Plane `:4200`
- `/mcp/services/:slug` -> MCP Gateway `:4100`
- `/rag-api` -> RAG Server `:4001`

## 验证

```bash
pnpm --filter @open-agent-tools/studio-web typecheck
pnpm --filter @open-agent-tools/studio-web lint
pnpm --filter @open-agent-tools/studio-web test
pnpm --filter @open-agent-tools/studio-web build
```

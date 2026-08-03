# open-agent-tools MCP Server

An **MCP (Model Context Protocol)** service project located under `apps/` in this monorepo.

## Transports

- **stdio** (default) — for local clients that launch the server as a subprocess.
- **Streamable HTTP** — set `MCP_HTTP_PORT` to expose the `/mcp` endpoint as a long-running service.

## Tools

| Tool                            | Description                  |
| ------------------------------- | ---------------------------- |
| `get_financial_reports(status)` | 按审批状态返回财务报表       |
| `get_server_time()`             | 返回服务当前时间（ISO 8601） |
| `add(a, b)`                     | 对两个整数求和               |

## Resources

- Static files: `welcome.txt`, `readme.md`, `diagram.svg`, `logo.png`
- Dynamic template: `open-agent-tools://reports/{status}` (approved / pending / rejected)

## Running

```bash
# stdio
pnpm --filter @open-agent-tools/mcp-server dev

# http service
MCP_HTTP_PORT=4100 pnpm --filter @open-agent-tools/mcp-server start
```

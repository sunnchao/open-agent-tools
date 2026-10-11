# Studio Web

`@open-agent-tools/studio-web` is the unified visual workspace for Agent chat, complete MCP administration and live Tool calls, RAG knowledge bases, and drag-and-drop workflow orchestration.

## MCP service environment variables

Select a service in MCP administration and click **环境变量** to configure runtime variables such as `TAVILY_API_KEY`. Configuration is shared by all Tool versions of that service and takes effect on the next invocation without rebuilding or publishing.

- Add, replace, and delete variables. Saved values are never returned to the browser; untouched values are retained.
- Names use letters, digits, and underscores and cannot start with a digit. Limits are 64 variables, 8192 characters per value, and 64 KiB total UTF-8 size.
- Runner controls (`MCP_*`), Node.js loader configuration (`NODE_OPTIONS` / `NODE_PATH`), and system loading paths cannot be overridden.
- Values are stored in the management database. The Worker loads them by service before execution and injects them through Docker `Env`; they are excluded from queue jobs, Tool arguments, and images.

Apply the migration history including `apps/mcp-worker/drizzle/0004_mcp_service_environment.sql` and restart the background Worker when deploying. Networked Tools also require `bridge` in the version's execution limits.

## MCP execution limits

After package inspection, the preview panel displays `timeoutMs`, `memoryMb`, `cpuMillis`, and `network` imported from `mcp.json`. Use **编辑限制** to save changes with optimistic revision checks. DRAFT, FAILED, and unpublished READY versions are editable; builds preserve the edited values. Published and superseded versions require a new draft.

`none` disables networking and `bridge` enables it. Limits apply to all Tools in the version and take effect after publication. Packages declaring `bridge` must be built using a Runner base image containing the updated contracts.

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

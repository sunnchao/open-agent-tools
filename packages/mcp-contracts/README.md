# MCP Contracts

[English](./README_EN.md) | [平台总览](../../README.md)

`@open-agent-tools/mcp-contracts` 是 Control Plane、Gateway、Worker 和 Node.js Runner 共享的数据契约包。它使用 Zod 同时提供运行时校验器与 TypeScript 类型，覆盖 Manifest、Prompt 渲染、BullMQ Job 和 Runner I/O。

## 导出内容

| 分类     | 主要导出                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Manifest | `ManagedMcpManifestSchema`、`ManagedToolSchema`、`PromptDefinitionSchema`、`ExecutionLimitsSchema`     |
| Prompt   | `renderPrompt`、`PromptRenderError`、`DEFAULT_MAX_PROMPT_OUTPUT_BYTES`                                 |
| Job      | `ArtifactInspectionJobSchema`、`ToolExecutionJobSchema`、`MCP_BUILD_QUEUE`、`MCP_TOOL_EXECUTION_QUEUE` |
| Runner   | `ToolRunnerInputSchema`、`ToolInvocationContextSchema`                                                 |

所有 Schema 均为严格对象校验，未知字段会被拒绝。

## `mcp.json` Manifest

```json
{
  "schemaVersion": 1,
  "runtime": { "name": "nodejs", "version": "20" },
  "entry": "dist/index.js",
  "build": { "command": "npm run build" },
  "tools": [
    {
      "name": "get_report",
      "description": "Get a report by id",
      "handler": "getReport",
      "inputSchema": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"],
        "additionalProperties": false
      }
    }
  ],
  "prompts": [],
  "limits": {
    "timeoutMs": 30000,
    "memoryMb": 256,
    "cpuMillis": 1000,
    "network": "none"
  }
}
```

Manifest 规则：

- `schemaVersion` 当前只能为 `1`。
- 至少配置一个 Tool 或 Prompt；同一类型内名称不能重复，但 Tool 和 Prompt 可使用相同名称。
- Tool/Prompt/参数名称必须匹配 `[a-zA-Z][a-zA-Z0-9_-]{0,63}`。
- Tool 的 `handler` 必须是合法的 JavaScript 导出标识符。
- 只要包含 Tool，就必须声明 Node.js `20`、安全的相对 `.js` 入口和执行限制。
- Prompt-only Manifest 不能包含 `runtime`、`entry`、`build` 或 `limits`。
- 唯一允许的构建命令是 `npm run build`，且配置 `build` 时必须同时配置 `entry`。
- Tool `inputSchema` 顶层必须为 JSON Schema Object。
- `network` 当前只能为 `none`；`timeoutMs` 最大 120 秒，内存最大 4096 MiB，CPU 最大 8000 millicores。

## Prompt 定义与渲染

Prompt 支持有序的 `user`/`assistant` 文本消息和声明式字符串参数。模板只支持精确的 `{{name}}` 占位符，不支持空格、属性访问、条件、Helper 或其他表达式。

```ts
import { renderPrompt } from "@open-agent-tools/mcp-contracts";

const rendered = renderPrompt(definition, {
  reportId: "report-1",
});
```

- 未声明参数、缺少必填参数或非字符串参数会抛出 `PromptRenderError`。
- 未提供的可选参数渲染为空字符串。
- 参数值只替换一次；参数值中出现的 `{{...}}` 不会再次解释。
- Prompt 模板总大小最大 64 KiB，渲染结果默认最大 256 KiB。

## 队列契约

| 队列               | 常量                 | Payload Schema                |
| ------------------ | -------------------- | ----------------------------- |
| Artifact 检查/构建 | `mcp-tool-build`     | `ArtifactInspectionJobSchema` |
| Tool 执行          | `mcp-tool-execution` | `ToolExecutionJobSchema`      |

Artifact Job 固定 Artifact 的对象键、SHA-256、字节数、服务版本与 Revision。Tool Execution Job 固定镜像 Digest、Tool 名称、参数、Client、Deadline 和执行限制。生产者和消费者都应在边界处执行 Schema 校验。

## Runner 输入

`ToolRunnerInputSchema` 只允许以下数据进入 Tool 容器：

```json
{
  "requestId": "req_123",
  "toolName": "get_report",
  "arguments": { "id": "report-1" },
  "context": {
    "serviceId": "svc_123",
    "versionId": "ver_3",
    "clientId": "client_8",
    "deadlineAt": "2026-07-31T12:00:30.000Z"
  }
}
```

Bearer Token、API Key、数据库凭据和内部主机信息不属于 Runner 契约，不得放入执行上下文。

## 兼容性要求

本包当前是 Monorepo 内部 `0.0.0` Workspace 包。Schema、队列名和错误语义是跨进程协议；修改时必须同步更新 Control Plane、Gateway、Worker、Runner、Fixture 和测试，并协调部署所有生产者与消费者。不要在各服务内复制独立的数据结构。

## 开发命令

```bash
pnpm --filter @open-agent-tools/mcp-contracts build
pnpm --filter @open-agent-tools/mcp-contracts test
pnpm --filter @open-agent-tools/mcp-contracts typecheck
pnpm --filter @open-agent-tools/mcp-contracts lint
```
